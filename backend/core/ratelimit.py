"""
Per-user sliding-window rate limiting.

settings.RATE_LIMIT_ENHANCE and RATE_LIMIT_VOICE have existed since the project
started and slowapi has been in requirements.txt the whole time, but nothing
ever constructed a Limiter — 20 rapid unauthenticated requests all succeeded.

This is deliberately not slowapi. slowapi resolves the caller by inspecting the
endpoint signature for a parameter named `request`, and in this codebase that
name is already taken by the Pydantic body model on /enhance and
/enhance/stream, so its decorator cannot find the HTTP request. It also keys on
IP by default, and every request to the Space arrives from the same proxy
address — an IP-keyed limiter would throttle the entire user base as one
client. Keying on the authenticated user id is both correct here and simpler
than working around slowapi's resolution order.

Per-process, like core.usage, and sound for the current single-worker
deployment. A shared store is required before scaling out.
"""

import threading
import time
from collections import defaultdict, deque

from fastapi import Depends, HTTPException

from .config import settings
from .security import verify_jwt

_lock = threading.Lock()
_hits: dict = defaultdict(deque)   # bucket key -> deque[timestamp]

_UNITS = {
    "second": 1, "sec": 1, "s": 1,
    "minute": 60, "min": 60, "m": 60,
    "hour": 3600, "hr": 3600, "h": 3600,
    "day": 86400, "d": 86400,
}


def parse_rule(rule: str, default=(30, 60)) -> tuple:
    """'30/minute' -> (30, 60). Falls back to `default` on anything unparseable."""
    try:
        count, _, unit = rule.strip().partition("/")
        seconds = _UNITS[unit.strip().lower().rstrip("s") or "minute"]
        return int(count), seconds
    except Exception:
        return default


def _check(key: str, limit: int, window: int) -> tuple:
    """Returns (allowed, retry_after_seconds)."""
    now = time.monotonic()
    cutoff = now - window
    with _lock:
        bucket = _hits[key]
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= limit:
            return False, max(1, int(bucket[0] + window - now) + 1)
        bucket.append(now)
        return True, 0


def limit(rule: str, scope: str):
    """
    Build a dependency enforcing `rule` for the authenticated user.

    Depends on verify_jwt, so an unauthenticated caller is still rejected with
    the usual 401 before any counting happens.
    """
    def dependency(user_id: str = Depends(verify_jwt)) -> str:
        limit_n, window = parse_rule(rule)
        allowed, retry_after = _check(f"{scope}:{user_id}", limit_n, window)
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail=f"Too many requests. Try again in {retry_after}s.",
                headers={"Retry-After": str(retry_after)},
            )
        return user_id
    return dependency


enhance_limit = limit(settings.RATE_LIMIT_ENHANCE, "enhance")
voice_limit = limit(settings.RATE_LIMIT_VOICE, "voice")
