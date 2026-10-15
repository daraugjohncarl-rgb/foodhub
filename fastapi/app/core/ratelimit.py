"""
Small in-process sliding-window rate limiter (no extra dependency).

Limits are per process: with several app instances each enforces its own window, so the effective limit is
multiplied by the instance count. Per-account login lockout is stored in the database (users.locked_until) and is
therefore global; this limiter only adds per-IP protection on top of it.
"""
import threading
import time
from collections import defaultdict, deque
from typing import Deque, Dict

from fastapi import Request


class SlidingWindowLimiter:
    def __init__(self, max_events: int, window_seconds: int):
        self.max_events = max_events
        self.window_seconds = window_seconds
        self._events: Dict[str, Deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> Deque[float]:
        events = self._events[key]
        while events and events[0] <= now - self.window_seconds:
            events.popleft()
        return events

    def is_limited(self, key: str) -> bool:
        with self._lock:
            return len(self._prune(key, time.monotonic())) >= self.max_events

    def hit(self, key: str) -> bool:
        """Records an event; returns True when the key is now over the limit."""
        with self._lock:
            now = time.monotonic()
            events = self._prune(key, now)
            events.append(now)
            return len(events) > self.max_events

    def reset(self, key: str = None) -> None:
        with self._lock:
            if key is None:
                self._events.clear()
            else:
                self._events.pop(key, None)


def client_ip(request: Request) -> str:
    """
    The direct peer address. X-Forwarded-For is only trusted when uvicorn runs with --proxy-headers behind a
    known proxy (Render does this), in which case request.client.host is already the real client.
    """
    return request.client.host if request.client else "unknown"
