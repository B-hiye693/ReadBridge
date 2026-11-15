"""Non-destructive API load, soak, concurrency, and security-boundary checks."""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import statistics
import time
from collections import Counter
from pathlib import Path

import httpx


def percentile(values: list[float], ratio: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil(len(ordered) * ratio) - 1))
    return round(ordered[index], 1)


def summarize(name: str, records: list[dict]) -> dict:
    latencies = [item["ms"] for item in records]
    statuses = Counter(str(item.get("status", "exception")) for item in records)
    passed = sum(1 for item in records if item.get("ok"))
    return {
        "name": name,
        "requests": len(records),
        "passed": passed,
        "failed": len(records) - passed,
        "status_counts": dict(statuses),
        "latency_ms": {
            "min": round(min(latencies), 1) if latencies else 0,
            "median": round(statistics.median(latencies), 1) if latencies else 0,
            "p95": percentile(latencies, 0.95),
            "p99": percentile(latencies, 0.99),
            "max": round(max(latencies), 1) if latencies else 0,
        },
    }


async def timed_request(client: httpx.AsyncClient, method: str, path: str, **kwargs) -> dict:
    started = time.perf_counter()
    try:
        response = await client.request(method, path, **kwargs)
        return {
            "ok": 200 <= response.status_code < 300,
            "status": response.status_code,
            "ms": (time.perf_counter() - started) * 1000,
            "cache": response.headers.get("X-ReadBridge-Cache") or response.headers.get("X-ReadBridge-TTS-Cache"),
            "content_type": response.headers.get("content-type", ""),
            "bytes": len(response.content),
        }
    except Exception as exc:
        return {
            "ok": False,
            "status": "exception",
            "ms": (time.perf_counter() - started) * 1000,
            "error_type": type(exc).__name__,
        }


def easy_payload(index: int, *, shared: bool = False) -> dict:
    suffix = "共享并发请求" if shared else f"负载样本{index}"
    text = f"{suffix}。今天发布一项通知。有关人员需要查看时间和办理步骤。"
    return {
        "title": suffix,
        "url": "https://example.invalid/system-validation",
        "text": text,
        "content_blocks": [
            {"id": "rb-1", "type": "paragraph", "text": text, "heading_context": suffix}
        ],
        "strategy": "system-validation",
        "truncated": False,
        "metrics": {"textLength": len(text)},
    }


async def run_load(base_url: str, requests: int, concurrency: int) -> dict:
    semaphore = asyncio.Semaphore(concurrency)
    async with httpx.AsyncClient(base_url=base_url, timeout=30, trust_env=False) as client:
        async def one(index: int) -> dict:
            async with semaphore:
                return await timed_request(client, "POST", "/api/easy-read", json=easy_payload(index))
        started = time.perf_counter()
        records = await asyncio.gather(*(one(i) for i in range(requests)))
        result = summarize("mock_load", records)
        result["concurrency"] = concurrency
        result["wall_seconds"] = round(time.perf_counter() - started, 3)
        result["throughput_rps"] = round(requests / max(result["wall_seconds"], 0.001), 2)
        return result


async def run_soak(base_url: str, seconds: int) -> dict:
    records: list[dict] = []
    started = time.perf_counter()
    iteration = 0
    async with httpx.AsyncClient(base_url=base_url, timeout=30, trust_env=False) as client:
        while time.perf_counter() - started < seconds:
            iteration += 1
            records.append(await timed_request(client, "GET", "/health"))
            records.append(await timed_request(client, "POST", "/api/easy-read", json=easy_payload(iteration % 10)))
            records.append(await timed_request(client, "POST", "/api/tts", json={
                "text": f"阅桥稳定性测试第{iteration % 10}段。", "language": "zh-CN",
                "voice": "mock-tone", "rate": 0.9, "style": "warm",
            }))
            await asyncio.sleep(0.2)
    result = summarize("mock_soak", records)
    result["configured_seconds"] = seconds
    result["actual_seconds"] = round(time.perf_counter() - started, 2)
    result["cycles"] = iteration
    return result


async def run_security(base_url: str) -> dict:
    checks = []
    async with httpx.AsyncClient(base_url=base_url, timeout=30, trust_env=False) as client:
        async def check(name: str, expected: set[int], method: str, path: str, **kwargs):
            response = await client.request(method, path, **kwargs)
            checks.append({"name": name, "status": response.status_code, "pass": response.status_code in expected})
            return response

        await check("invalid_json", {422}, "POST", "/api/easy-read", content=b"{", headers={"Content-Type": "application/json"})
        await check("easy_read_empty", {422}, "POST", "/api/easy-read", json={"text": ""})
        await check("easy_read_oversize", {422}, "POST", "/api/easy-read", json={"text": "测" * 60001})
        await check("explain_oversize", {422}, "POST", "/api/explain", json={"text": "测" * 10001})
        await check("invalid_block_id", {422}, "POST", "/api/easy-read", json={"text": "测试", "content_blocks": [{"id": "bad", "type": "p", "text": "测试"}]})
        await check("tts_empty", {422}, "POST", "/api/tts", json={"text": ""})
        await check("tts_oversize", {422}, "POST", "/api/tts", json={"text": "测" * 601})
        await check("tts_bad_rate", {422}, "POST", "/api/tts", json={"text": "测试", "rate": 9})
        await check("tts_bad_voice_chars", {422}, "POST", "/api/tts", json={"text": "测试", "voice": "../../x"})
        await check("unsupported_put", {405}, "PUT", "/api/easy-read", json={"text": "测试"})
        await check("missing_route", {404}, "GET", "/does-not-exist")
        cors = await client.options("/api/easy-read", headers={
            "Origin": "https://attacker.invalid",
            "Access-Control-Request-Method": "POST",
        })
        checks.append({
            "name": "untrusted_origin_no_allow_origin",
            "status": cors.status_code,
            "allow_origin": cors.headers.get("access-control-allow-origin"),
            "pass": cors.headers.get("access-control-allow-origin") is None,
        })
    return {"name": "security_boundary", "checks": checks, "passed": sum(x["pass"] for x in checks), "failed": sum(not x["pass"] for x in checks)}


async def run_real_concurrency(base_url: str) -> dict:
    nonce = int(time.time())
    easy = easy_payload(nonce, shared=True)
    easy["text"] += f" 请求编号{nonce}。"
    easy["content_blocks"][0]["text"] = easy["text"]
    tts = {"text": f"阅桥真实并发测试，编号{nonce}。", "language": "zh-CN", "voice": "longyingling_v3", "rate": 0.9, "style": "warm"}
    async with httpx.AsyncClient(base_url=base_url, timeout=180, trust_env=False) as client:
        easy_records = await asyncio.gather(*(timed_request(client, "POST", "/api/easy-read", json=easy) for _ in range(3)))
        tts_records = await asyncio.gather(*(timed_request(client, "POST", "/api/tts", json=tts) for _ in range(3)))
    result = {
        "name": "real_concurrency",
        "qwen": summarize("qwen", easy_records),
        "qwen_cache_states": dict(Counter(str(x.get("cache")) for x in easy_records)),
        "cosyvoice": summarize("cosyvoice", tts_records),
        "cosyvoice_cache_states": dict(Counter(str(x.get("cache")) for x in tts_records)),
        "cosyvoice_bytes": sorted({x.get("bytes", 0) for x in tts_records}),
    }
    result["pass"] = result["qwen"]["failed"] == 0 and result["cosyvoice"]["failed"] == 0
    return result


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["load", "soak", "security", "real"])
    parser.add_argument("--base-url", default="http://127.0.0.1:8013")
    parser.add_argument("--requests", type=int, default=200)
    parser.add_argument("--concurrency", type=int, default=20)
    parser.add_argument("--seconds", type=int, default=180)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.mode == "load":
        result = await run_load(args.base_url, args.requests, args.concurrency)
    elif args.mode == "soak":
        result = await run_soak(args.base_url, args.seconds)
    elif args.mode == "security":
        result = await run_security(args.base_url)
    else:
        result = await run_real_concurrency(args.base_url)
    result["timestamp"] = time.strftime("%Y-%m-%d %H:%M:%S")
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
