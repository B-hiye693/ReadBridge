"""CosyVoice connectivity diagnostic that never prints credentials or input text."""
from __future__ import annotations

import asyncio
import json
import os
import socket
import ssl
from pathlib import Path
from urllib.parse import urlparse

import httpx


def load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


async def main() -> None:
    env = load_env(Path(__file__).resolve().parents[1] / ".env")
    endpoint = env.get("TTS_BASE_URL", "")
    key = env.get("TTS_API_KEY") or env.get("QWEN_API_KEY", "")
    parsed = urlparse(endpoint)
    print(json.dumps({
        "stage": "config",
        "scheme": parsed.scheme,
        "host": parsed.hostname,
        "path": parsed.path,
        "key_configured": bool(key),
        "model": env.get("TTS_MODEL"),
        "voice": env.get("TTS_VOICE"),
        "format": env.get("TTS_AUDIO_FORMAT"),
    }, ensure_ascii=False))

    addresses = sorted({item[4][0] for item in socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)})
    print(json.dumps({"stage": "dns", "addresses": addresses}, ensure_ascii=False))

    context = ssl.create_default_context()
    try:
        with socket.create_connection((parsed.hostname, 443), timeout=10) as raw:
            with context.wrap_socket(raw, server_hostname=parsed.hostname) as tls:
                cert = tls.getpeercert()
                print(json.dumps({
                    "stage": "tls",
                    "ok": True,
                    "version": tls.version(),
                    "subject": cert.get("subject", []),
                    "issuer": cert.get("issuer", []),
                }, ensure_ascii=False, default=str))
    except Exception as exc:
        print(json.dumps({"stage": "tls", "ok": False, "error_type": type(exc).__name__, "error": str(exc)}, ensure_ascii=False))

    payload = {
        "model": env.get("TTS_MODEL", "cosyvoice-v3-flash"),
        "input": {
            "text": "欢迎使用阅桥。",
            "voice": env.get("TTS_VOICE", "longyingling_v3"),
            "format": env.get("TTS_AUDIO_FORMAT", "mp3"),
            "sample_rate": 24000,
        },
    }
    for trust_env in (True, False):
        try:
            async with httpx.AsyncClient(timeout=60, trust_env=trust_env, follow_redirects=False) as client:
                response = await client.post(endpoint, headers={"Authorization": f"Bearer {key}"}, json=payload)
                try:
                    data = response.json()
                except ValueError:
                    data = {}
                output = data.get("output") if isinstance(data, dict) else None
                audio = output.get("audio") if isinstance(output, dict) else None
                print(json.dumps({
                    "stage": "post",
                    "trust_env": trust_env,
                    "status": response.status_code,
                    "content_type": response.headers.get("content-type", ""),
                    "server": response.headers.get("server", ""),
                    "request_id": (data.get("request_id", "") if isinstance(data, dict) else ""),
                    "provider_code": (data.get("code", "") if isinstance(data, dict) else ""),
                    "provider_message": (data.get("message", "") if isinstance(data, dict) else "")[:240],
                    "audio_url_present": bool(audio.get("url")) if isinstance(audio, dict) else False,
                    "audio_data_present": bool(audio.get("data")) if isinstance(audio, dict) else False,
                    "body_length": len(response.content),
                }, ensure_ascii=False))
        except Exception as exc:
            chain = []
            current: BaseException | None = exc
            while current is not None and len(chain) < 6:
                chain.append({"type": type(current).__name__, "message": str(current)})
                current = current.__cause__
            print(json.dumps({"stage": "post", "trust_env": trust_env, "exception_chain": chain}, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
