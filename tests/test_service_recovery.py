"""Verify that a client observes outage and succeeds after a local service restart."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx


ROOT = Path(__file__).resolve().parents[1]
URL = "http://127.0.0.1:8015/health"


def start_server() -> subprocess.Popen:
    env = os.environ.copy()
    env.update({"AI_PROVIDER": "mock", "TTS_PROVIDER": "mock", "PERFORMANCE_LOGS": "false"})
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    return subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server.main:app", "--host", "127.0.0.1", "--port", "8015"],
        cwd=ROOT,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=flags,
    )


def wait_ready(timeout: float = 15) -> tuple[bool, float]:
    started = time.perf_counter()
    with httpx.Client(timeout=1, trust_env=False) as client:
        while time.perf_counter() - started < timeout:
            try:
                response = client.get(URL)
                if response.status_code == 200:
                    return True, round((time.perf_counter() - started) * 1000, 1)
            except httpx.HTTPError:
                pass
            time.sleep(0.1)
    return False, round((time.perf_counter() - started) * 1000, 1)


def stop_server(process: subprocess.Popen) -> None:
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main() -> None:
    first = start_server()
    first_ready, first_ms = wait_ready()
    if not first_ready:
        stop_server(first)
        raise SystemExit("initial start failed")
    stop_server(first)
    outage_observed = False
    try:
        httpx.get(URL, timeout=1, trust_env=False)
    except httpx.HTTPError:
        outage_observed = True
    second = start_server()
    try:
        recovered, recovery_ms = wait_ready()
        result = {
            "initial_start": first_ready,
            "initial_ready_ms": first_ms,
            "outage_observed": outage_observed,
            "restart_recovered": recovered,
            "restart_ready_ms": recovery_ms,
            "pass": first_ready and outage_observed and recovered,
        }
        (ROOT / "tests" / "results_service_recovery.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(json.dumps(result, ensure_ascii=False))
        if not result["pass"]:
            raise SystemExit(1)
    finally:
        stop_server(second)


if __name__ == "__main__":
    main()
