"""统一 TTS Provider、CosyVoice HTTP Provider 与有界内存缓存。"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import io
import json
import logging
import math
import struct
import wave
from abc import ABC, abstractmethod
from collections import OrderedDict
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse, urlunparse

import httpx

logger = logging.getLogger(__name__)
COSYVOICE_PATH = "/api/v1/services/audio/tts/SpeechSynthesizer"
ALLOWED_AUDIO_HOST_SUFFIXES = (".aliyuncs.com",)
SUPPORTED_FORMATS = {"mp3": "audio/mpeg", "wav": "audio/wav", "opus": "audio/ogg"}


class TTSProviderError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 502, code: str = "tts_failed",
                 provider_status: Optional[int] = None, request_id: str = ""):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.provider_status = provider_status
        self.request_id = request_id

    def public_detail(self) -> dict:
        detail = {"code": self.code, "message": str(self)}
        if self.provider_status is not None:
            detail["provider_status"] = self.provider_status
        if self.request_id:
            detail["request_id"] = self.request_id
        return detail


@dataclass(frozen=True)
class TTSAudio:
    content: bytes
    media_type: str
    extension: str


COSYVOICE_V3_FLASH_VOICES = [
    {"id": "longyingling_v3", "name": "自然女声（温和共情）", "language": "zh-CN", "gender": "female"},
    {"id": "longanrou_v3", "name": "自然女声（亲切柔和）", "language": "zh-CN", "gender": "female"},
    {"id": "longanzhi_v3", "name": "自然男声（沉稳睿智）", "language": "zh-CN", "gender": "male"},
    {"id": "longhan_v3", "name": "自然男声（温暖专注）", "language": "zh-CN", "gender": "male"},
]
MODEL_VOICES = {"cosyvoice-v3-flash": COSYVOICE_V3_FLASH_VOICES}
# 官方音色表明确标注上述默认音色不支持 Instruct，因此绝不发送 instruction。
INSTRUCTION_VOICES = {"longanyang", "longanhuan", "longanhuan_v3"}


def _valid_host(hostname: Optional[str]) -> bool:
    return bool(hostname and (hostname == "dashscope.aliyuncs.com" or hostname.endswith(ALLOWED_AUDIO_HOST_SUFFIXES)))


def validate_audio(content: bytes, expected_format: str = "") -> tuple[str, str]:
    if len(content) < 128:
        raise TTSProviderError("语音服务返回的音频数据为空或过短。", code="invalid_audio_response")
    if content.startswith(b"RIFF") and content[8:12] == b"WAVE":
        detected = ("audio/wav", "wav")
    elif content.startswith(b"OggS"):
        detected = ("audio/ogg", "opus")
    elif content.startswith(b"ID3") or (content[0] == 0xFF and content[1] & 0xE0 == 0xE0):
        detected = ("audio/mpeg", "mp3")
    else:
        raise TTSProviderError("语音服务返回的内容不是有效的 MP3、WAV 或 OGG 音频。", code="invalid_audio_response")
    if expected_format in SUPPORTED_FORMATS and detected[1] != expected_format:
        raise TTSProviderError("语音服务返回的音频格式与请求不一致。", code="invalid_audio_response")
    return detected


class TTSProvider(ABC):
    name = "base"
    display_name = "TTS"
    neural = False
    model = ""

    def __init__(self, default_voice: str = ""):
        self.default_voice = default_voice

    @abstractmethod
    async def synthesize(self, text: str, language: str, voice: str, rate: float, style: str) -> TTSAudio:
        raise NotImplementedError

    def voices(self) -> list[dict[str, str]]:
        return []


class BrowserTTSProvider(TTSProvider):
    name = "browser"
    display_name = "系统语音"

    async def synthesize(self, text: str, language: str, voice: str, rate: float, style: str) -> TTSAudio:
        raise TTSProviderError("当前服务配置为系统语音，请在浏览器中直接朗读。", status_code=409, code="browser_only")


class MockTTSProvider(TTSProvider):
    """仅用于开发测试，不代表真人或神经网络语音。"""
    name = "mock"
    display_name = "测试音频"
    neural = True

    def voices(self) -> list[dict[str, str]]:
        return [{"id": "mock-tone", "name": "开发测试音（非真人）", "language": "zh-CN", "gender": "unknown"}]

    async def synthesize(self, text: str, language: str, voice: str, rate: float, style: str) -> TTSAudio:
        sample_rate, duration = 16000, min(1.5, max(0.18, len(text) * 0.018 / rate))
        frames, buffer = int(sample_rate * duration), io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(sample_rate)
            for index in range(frames):
                fade = min(1.0, index / 400, (frames - index) / 400)
                wav.writeframesraw(struct.pack("<h", int(1800 * fade * math.sin(2 * math.pi * 440 * index / sample_rate))))
        return TTSAudio(buffer.getvalue(), "audio/wav", "wav")


class CosyVoiceTTSProvider(TTSProvider):
    name = "cosyvoice"
    display_name = "神经语音（CosyVoice）"
    neural = True

    def __init__(self, *, api_key: str, model: str, endpoint: str, default_voice: str,
                 timeout_seconds: float, audio_format: str, instruction: str = "",
                 transport: Optional[httpx.AsyncBaseTransport] = None):
        if not api_key:
            raise TTSProviderError("神经语音未配置 API Key。", status_code=503, code="not_configured")
        super().__init__(default_voice)
        self.api_key, self.model = api_key, model
        self.endpoint = self._validate_endpoint(endpoint)
        self.endpoint_host = urlparse(self.endpoint).hostname or ""
        self.timeout = timeout_seconds
        if audio_format not in SUPPORTED_FORMATS:
            raise TTSProviderError("TTS_AUDIO_FORMAT 仅支持 mp3、wav 或 opus。", status_code=503, code="unsupported_format")
        self.audio_format, self.instruction, self.transport = audio_format, instruction.strip(), transport
        self._client: Optional[httpx.AsyncClient] = None
        if model not in MODEL_VOICES:
            raise TTSProviderError("当前 TTS 模型没有经过阅桥兼容性验证，请检查 TTS_MODEL。", status_code=503, code="invalid_model")
        voice_ids = {item["id"] for item in MODEL_VOICES[model]}
        if default_voice not in voice_ids:
            raise TTSProviderError("默认音色与当前 TTS 模型不兼容。", status_code=503, code="invalid_voice")

    @staticmethod
    def _validate_endpoint(value: str) -> str:
        parsed = urlparse(value.strip())
        if parsed.scheme != "https" or not _valid_host(parsed.hostname) or parsed.path.rstrip("/") != COSYVOICE_PATH:
            raise TTSProviderError(
                "TTS_BASE_URL 必须填写完整的 CosyVoice SpeechSynthesizer HTTPS 地址，不能使用 /compatible-mode/v1。",
                status_code=503, code="invalid_endpoint",
            )
        return urlunparse((parsed.scheme, parsed.netloc, COSYVOICE_PATH, "", "", ""))

    def voices(self) -> list[dict[str, str]]:
        return list(MODEL_VOICES[self.model])

    def _http_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                timeout=self.timeout, transport=self.transport,
                limits=httpx.Limits(max_keepalive_connections=8, max_connections=16),
                # 服务地址已由 _validate_endpoint 限定为阿里云 HTTPS 域名。
                # 不继承本机/环境代理，避免无效系统代理把直连请求转换为 502。
                trust_env=False,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    @staticmethod
    def _provider_error(status: int, data: dict, request_id: str) -> TTSProviderError:
        provider_code = str(data.get("code") or "")
        provider_message = str(data.get("message") or "")
        token = f"{provider_code} {provider_message}".lower()
        if status == 401 or any(x in token for x in ("invalidapikey", "invalid api-key", "unauthorized")):
            return TTSProviderError("TTS API Key 无效。", code="authentication_failed", provider_status=status, request_id=request_id)
        if status == 403 or any(x in token for x in ("permission", "accessdenied", "forbidden")):
            return TTSProviderError("当前 API Key 没有调用该 TTS 模型的权限。", code="permission_denied", provider_status=status, request_id=request_id)
        if status == 429 or any(x in token for x in ("quota", "rate limit", "throttl")):
            return TTSProviderError("神经语音额度不足或请求过于频繁。", status_code=429, code="quota_exceeded", provider_status=status, request_id=request_id)
        if "model" in token and any(x in token for x in ("invalid", "not exist", "not found", "unsupported")):
            return TTSProviderError("当前 TTS 模型不可用，请检查 TTS_MODEL 配置。", code="invalid_model", provider_status=status, request_id=request_id)
        if "voice" in token:
            return TTSProviderError("当前音色不可用或与模型不兼容。", code="invalid_voice", provider_status=status, request_id=request_id)
        if "format" in token:
            return TTSProviderError("当前音频格式不受支持。", code="unsupported_format", provider_status=status, request_id=request_id)
        if status == 400 or any(x in token for x in ("invalidparameter", "invalid parameter")):
            return TTSProviderError("神经语音请求参数无效，请检查服务端 TTS 配置。", code="invalid_parameter", provider_status=status, request_id=request_id)
        return TTSProviderError("神经语音服务暂时不可用。", code="provider_error", provider_status=status, request_id=request_id)

    async def synthesize(self, text: str, language: str, voice: str, rate: float, style: str) -> TTSAudio:
        selected_voice = voice or self.default_voice
        if selected_voice not in {item["id"] for item in self.voices()}:
            raise TTSProviderError("所选音色与当前模型不兼容。", status_code=400, code="invalid_voice")
        input_data = {"text": text, "voice": selected_voice, "format": self.audio_format, "rate": rate,
                      "language_hints": ["zh" if language == "zh-CN" else "en"]}
        if self.instruction and selected_voice in INSTRUCTION_VOICES:
            input_data["instruction"] = self.instruction
        payload = {"model": self.model, "input": input_data}
        text_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
        try:
            client = self._http_client()
            response = await client.post(self.endpoint, headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}, json=payload)
            content_type = response.headers.get("content-type", "").lower()
            if content_type.startswith("audio/") and response.is_success:
                media_type, extension = validate_audio(response.content, self.audio_format)
                return TTSAudio(response.content, media_type, extension)
            try:
                result = response.json()
            except (json.JSONDecodeError, ValueError):
                result = {}
            request_id = str(result.get("request_id") or response.headers.get("x-request-id") or "")
            if not response.is_success:
                exc = self._provider_error(response.status_code, result, request_id)
                logger.warning("TTS provider failure provider=%s endpoint_host=%s model=%s voice=%s status=%s code=%s request_id=%s text_length=%s text_hash=%s",
                               self.name, self.endpoint_host, self.model, selected_voice, response.status_code,
                               result.get("code", ""), request_id, len(text), text_hash)
                raise exc
            audio = result.get("output", {}).get("audio", {})
            data = audio.get("data") or ""
            if data:
                try:
                    content = base64.b64decode(data, validate=True)
                except (binascii.Error, ValueError) as exc:
                    raise TTSProviderError("语音服务返回了无效 Base64 音频。", code="invalid_audio_response", request_id=request_id) from exc
            else:
                audio_url = str(audio.get("url") or "")
                parsed = urlparse(audio_url)
                if parsed.scheme not in {"http", "https"} or not _valid_host(parsed.hostname):
                    raise TTSProviderError("语音服务返回了不安全的音频地址。", code="invalid_audio_response", request_id=request_id)
                # 官方目前可能返回 HTTP OSS 签名地址；升级到 HTTPS 后再下载，避免明文传输。
                if parsed.scheme == "http":
                    audio_url = urlunparse(("https", parsed.netloc, parsed.path, parsed.params, parsed.query, parsed.fragment))
                audio_response = await client.get(audio_url)
                if not audio_response.is_success:
                    raise TTSProviderError("生成成功，但下载音频失败。", code="network_error", provider_status=audio_response.status_code, request_id=request_id)
                content = audio_response.content
            media_type, extension = validate_audio(content, self.audio_format)
            return TTSAudio(content, media_type, extension)
        except TTSProviderError:
            raise
        except httpx.TimeoutException as exc:
            raise TTSProviderError("神经语音生成超时，请稍后重试。", status_code=504, code="timeout") from exc
        except httpx.HTTPError as exc:
            raise TTSProviderError("无法连接神经语音服务，请检查网络后重试。", code="network_error") from exc


class TTSAudioCache:
    def __init__(self, max_entries: int, max_bytes: int):
        self.max_entries, self.max_bytes = max(1, max_entries), max(1024, max_bytes)
        self._items: OrderedDict[str, TTSAudio] = OrderedDict(); self._bytes = 0; self._lock = asyncio.Lock()

    @staticmethod
    def key(provider: str, model: str, voice: str, rate: float, style: str, text: str) -> str:
        return hashlib.sha256("\0".join([provider, model, voice, str(rate), style, text]).encode("utf-8")).hexdigest()

    async def get(self, key: str) -> Optional[TTSAudio]:
        async with self._lock:
            value = self._items.pop(key, None)
            if value: self._items[key] = value
            return value

    async def put(self, key: str, value: TTSAudio) -> None:
        if len(value.content) > self.max_bytes: return
        async with self._lock:
            old = self._items.pop(key, None)
            if old: self._bytes -= len(old.content)
            self._items[key] = value; self._bytes += len(value.content)
            while len(self._items) > self.max_entries or self._bytes > self.max_bytes:
                _, removed = self._items.popitem(last=False); self._bytes -= len(removed.content)


def create_tts_provider(settings) -> TTSProvider:
    provider = settings.tts_provider.strip().lower()
    if provider == "browser": return BrowserTTSProvider(settings.tts_voice)
    if provider == "mock": return MockTTSProvider("mock-tone")
    if provider in {"cosyvoice", "neural"}:
        api_key = settings.tts_api_key or settings.qwen_api_key
        return CosyVoiceTTSProvider(api_key=api_key.get_secret_value() if api_key else "", model=settings.tts_model,
            endpoint=settings.tts_base_url, default_voice=settings.tts_voice, timeout_seconds=settings.tts_timeout_seconds,
            audio_format=settings.tts_audio_format, instruction=settings.tts_instruction)
    raise TTSProviderError(f"不支持的 TTS_PROVIDER：{provider}", status_code=503, code="not_configured")
