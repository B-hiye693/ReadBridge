"""轻量性能工具：TTL/LRU 缓存、并发请求合并和结构化计时。"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import json
import logging
import time
from typing import Awaitable, Callable, Generic, TypeVar

T = TypeVar("T")
logger = logging.getLogger("uvicorn.error")


def stable_hash(*parts: object) -> str:
    raw = json.dumps(parts, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@dataclass
class _Entry(Generic[T]):
    value: T
    expires_at: float


class AsyncTTLCache(Generic[T]):
    """有上限的 TTL/LRU 缓存，并合并相同 key 的并发计算。"""

    def __init__(self, max_entries: int = 64, ttl_seconds: float = 900) -> None:
        self.max_entries = max(1, max_entries)
        self.ttl_seconds = max(1.0, ttl_seconds)
        self._items: OrderedDict[str, _Entry[T]] = OrderedDict()
        self._inflight: dict[str, asyncio.Task[T]] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(self, key: str, factory: Callable[[], Awaitable[T]]) -> tuple[T, str]:
        now = time.monotonic()
        async with self._lock:
            entry = self._items.get(key)
            if entry and entry.expires_at > now:
                self._items.move_to_end(key)
                return entry.value, "hit"
            if entry:
                self._items.pop(key, None)
            task = self._inflight.get(key)
            if task:
                state = "shared"
            else:
                task = asyncio.create_task(factory())
                self._inflight[key] = task
                state = "miss"
        try:
            value = await asyncio.shield(task)
        except asyncio.CancelledError:
            raise
        finally:
            if task.done():
                async with self._lock:
                    if self._inflight.get(key) is task:
                        self._inflight.pop(key, None)
        # 首个客户端取消后，后台任务仍可作为明确的缓存预热；后续共享等待者负责落缓存。
        if state in {"miss", "shared"}:
            async with self._lock:
                self._items[key] = _Entry(value, time.monotonic() + self.ttl_seconds)
                self._items.move_to_end(key)
                while len(self._items) > self.max_entries:
                    self._items.popitem(last=False)
        return value, state


class PerfTimer:
    def __init__(self, request_id: str, operation: str, enabled: bool = True) -> None:
        self.request_id = request_id
        self.operation = operation
        self.enabled = enabled
        self.started = time.perf_counter()
        self.marks: dict[str, float] = {}

    def mark(self, name: str, started: float) -> None:
        self.marks[name] = round((time.perf_counter() - started) * 1000, 1)

    @property
    def total_ms(self) -> float:
        return round((time.perf_counter() - self.started) * 1000, 1)

    def log(self, **extra: object) -> None:
        if self.enabled:
            logger.info("PERF %s", json.dumps({
                "request_id": self.request_id, "operation": self.operation,
                "total_ms": self.total_ms, **self.marks, **extra,
            }, ensure_ascii=False, separators=(",", ":")))
