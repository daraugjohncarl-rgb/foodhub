"""
Lightweight in-process sliding-window rate limiter.

This protects a single application instance. When the app runs on several
instances/workers, enforce the same limits at the proxy or CDN layer as well
(see PRODUCTION_READINESS.md); counters here are per process.
"""
import os
import time
import threading
from collections import defaultdict, deque
from typing import Deque, Dict

from fastapi import HTTPException, Request, status


def _enabled() -> bool:
    return os.getenv("RATE_LIMIT_ENABLED", "true").strip().lower() not in ("0", "false", "no", "off")


class SlidingWindowLimiter:
    def __init__(self, max_calls: int, window_seconds: int, scope: str):
        self.max_calls = max_calls
        self.window = window_seconds
        self.scope = scope
        self._hits: Dict[str, Deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()
        _REGISTRY.append(self)

    def _prune(self, bucket: Deque[float], now: float) -> None:
        while bucket and now - bucket[0] > self.window:
            bucket.popleft()

    def is_limited(self, key: str) -> bool:
        if not _enabled():
            return False
        now = time.monotonic()
        with self._lock:
            bucket = self._hits.get(key)
            if not bucket:
                return False
            self._prune(bucket, now)
            return len(bucket) >= self.max_calls

    def record(self, key: str) -> None:
        if not _enabled():
            return
        now = time.monotonic()
        with self._lock:
            bucket = self._hits[key]
            self._prune(bucket, now)
            bucket.append(now)
            # Bound memory: drop idle keys opportunistically.
            if len(self._hits) > 10000:
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] > self.window]:
                    self._hits.pop(k, None)

    def clear(self, key: str = None) -> None:
        with self._lock:
            if key is None:
                self._hits.clear()
            else:
                self._hits.pop(key, None)

    def hit(self, key: str) -> None:
        """Count a call and raise 429 if the key is over its limit."""
        if not _enabled():
            return
        if self.is_limited(key):
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests. Please try again later.",
                headers={"Retry-After": str(self.window)},
            )
        self.record(key)


_REGISTRY: list = []


def reset_all_limiters() -> None:
    """Test helper: clear every limiter's counters."""
    for limiter in _REGISTRY:
        limiter.clear()


def client_ip(request: Request) -> str:
    """
    Client address used as the rate-limit key.

    X-Forwarded-For is client-controlled on its left side, so it is only consulted when
    TRUSTED_PROXY_COUNT (number of proxies you operate/trust in front of the app) is set, and then
    the entry that many hops from the RIGHT is used (the one your own proxy appended). With the
    default of 0 the socket peer address is used. uvicorn's --proxy-headers is deliberately NOT
    enabled because FORWARDED_ALLOW_IPS=* would let callers spoof their address.
    """
    peer = request.client.host if request.client else "unknown"
    try:
        hops = int(os.getenv("TRUSTED_PROXY_COUNT", "0"))
    except ValueError:
        hops = 0
    if hops > 0:
        parts = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
        if len(parts) >= hops:
            return parts[-hops]
    return peer


def rate_limit(max_calls: int, window_seconds: int, scope: str):
    """FastAPI dependency factory: limit calls per client IP for a scope."""
    limiter = SlidingWindowLimiter(max_calls, window_seconds, scope)

    def dependency(request: Request) -> None:
        limiter.hit(f"{scope}:{client_ip(request)}")

    return dependency
