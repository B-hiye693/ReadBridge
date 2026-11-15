"""本地 API 性能基准。不会打印正文或密钥。"""
from __future__ import annotations
import json, time, urllib.request

BASE = "http://127.0.0.1:8000"

def post(path: str, payload: dict):
    request = urllib.request.Request(BASE + path, json.dumps(payload, ensure_ascii=False).encode(), {"Content-Type": "application/json"})
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=180) as response:
        body = response.read()
        return {"status": response.status, "elapsed_ms": round((time.perf_counter()-started)*1000, 1),
                "bytes": len(body), "cache": response.headers.get("X-ReadBridge-Cache") or response.headers.get("X-ReadBridge-TTS-Cache")}

if __name__ == "__main__":
    text = "阅桥把复杂网页转换成更容易理解的内容。" * 60
    print("easy_read_cold", post("/api/easy-read", {"title":"性能基准", "url":"https://example.invalid/benchmark", "text":text, "content_blocks":[]}))
    print("easy_read_cache", post("/api/easy-read", {"title":"性能基准", "url":"https://example.invalid/benchmark", "text":text, "content_blocks":[]}))
    print("tts", post("/api/tts", {"text":"阅桥正在准备第一段语音。", "language":"zh-CN", "voice":"", "rate":0.9, "style":"warm"}))
