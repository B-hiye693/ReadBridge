import asyncio
import logging
import unittest

import httpx
from fastapi.testclient import TestClient

import server.main as main_module
from server.tts import CosyVoiceTTSProvider, MockTTSProvider, TTSAudioCache, TTSProviderError, validate_audio


class TTSProviderTests(unittest.TestCase):
    def test_mock_returns_valid_wav_and_cache_is_bounded(self):
        async def scenario():
            provider = MockTTSProvider("mock-tone")
            audio = await provider.synthesize("欢迎使用阅桥。", "zh-CN", "mock-tone", 0.9, "warm")
            self.assertEqual(audio.media_type, "audio/wav")
            self.assertTrue(audio.content.startswith(b"RIFF"))
            cache = TTSAudioCache(max_entries=1, max_bytes=100000)
            await cache.put("one", audio)
            await cache.put("two", audio)
            self.assertIsNone(await cache.get("one"))
            self.assertIsNotNone(await cache.get("two"))
        asyncio.run(scenario())

    def make_provider(self, handler, key="secret-key-never-log"):
        return CosyVoiceTTSProvider(
            api_key=key,
            model="cosyvoice-v3-flash",
            endpoint="https://llm-test.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
            default_voice="longyingling_v3",
            timeout_seconds=10,
            audio_format="mp3",
            transport=httpx.MockTransport(handler),
        )

    def test_provider_maps_auth_and_preserves_diagnostics_without_key(self):
        def handler(request):
            return httpx.Response(401, json={"code": "InvalidApiKey", "message": "bad key", "request_id": "req-auth"})
        provider = self.make_provider(handler)
        with self.assertLogs("server.tts", logging.WARNING) as captured:
            with self.assertRaises(TTSProviderError) as raised:
                asyncio.run(provider.synthesize("你好", "zh-CN", "longyingling_v3", 0.9, "warm"))
        self.assertEqual(raised.exception.code, "authentication_failed")
        self.assertEqual(raised.exception.provider_status, 401)
        self.assertEqual(raised.exception.request_id, "req-auth")
        self.assertNotIn("secret-key-never-log", " ".join(captured.output))

    def test_provider_maps_invalid_parameter(self):
        provider = self.make_provider(lambda request: httpx.Response(400, json={"code": "InvalidParameter", "message": "voice is invalid", "request_id": "req-400"}))
        with self.assertRaises(TTSProviderError) as raised:
            asyncio.run(provider.synthesize("你好", "zh-CN", "longyingling_v3", 0.9, "warm"))
        self.assertEqual(raised.exception.code, "invalid_voice")
        self.assertEqual(raised.exception.provider_status, 400)

    def test_json_success_is_not_mistaken_for_audio(self):
        provider = self.make_provider(lambda request: httpx.Response(200, json={"request_id": "req-empty", "output": {"audio": {}}}))
        with self.assertRaises(TTSProviderError) as raised:
            asyncio.run(provider.synthesize("你好", "zh-CN", "longyingling_v3", 0.9, "warm"))
        self.assertEqual(raised.exception.code, "invalid_audio_response")

    def test_http_client_does_not_inherit_environment_proxy(self):
        provider = self.make_provider(lambda request: httpx.Response(200, content=b"ID3" + b"\0" * 300,
                                                                      headers={"content-type": "audio/mpeg"}))
        client = provider._http_client()
        # httpx 在 trust_env=False 时不会从系统或环境变量读取代理配置。
        self.assertIsInstance(client, httpx.AsyncClient)
        self.assertFalse(client._trust_env)
        asyncio.run(provider.aclose())

    def test_valid_mp3_url_is_downloaded_and_validated(self):
        mp3 = b"ID3" + b"\0" * 300
        def handler(request):
            if request.url.path.endswith("SpeechSynthesizer"):
                return httpx.Response(200, json={"request_id": "req-ok", "output": {"audio": {"url": "http://files.oss-cn-beijing.aliyuncs.com/a.mp3"}}})
            return httpx.Response(200, headers={"content-type": "audio/mpeg"}, content=mp3)
        audio = asyncio.run(self.make_provider(handler).synthesize("你好", "zh-CN", "longyingling_v3", 0.9, "warm"))
        self.assertEqual(audio.media_type, "audio/mpeg")
        self.assertEqual(audio.content, mp3)
        self.assertEqual(validate_audio(audio.content), ("audio/mpeg", "mp3"))

    def test_api_voices_validation_and_wav_response(self):
        original = main_module.tts_provider
        main_module.tts_provider = MockTTSProvider("mock-tone")
        try:
            client = TestClient(main_module.app)
            voices = client.get("/api/tts/voices")
            self.assertEqual(voices.status_code, 200)
            self.assertEqual(voices.json()["default_voice"], "mock-tone")
            self.assertEqual(client.post("/api/tts", json={"text": ""}).status_code, 422)
            invalid = client.post("/api/tts", json={"text": "你好", "voice": "other"})
            self.assertEqual(invalid.status_code, 400)
            response = client.post("/api/tts", json={"text": "你好", "voice": "mock-tone", "rate": 0.9, "style": "warm"})
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.headers["content-type"].startswith("audio/wav"))
            self.assertTrue(response.content.startswith(b"RIFF"))
        finally:
            main_module.tts_provider = original


if __name__ == "__main__":
    unittest.main()
