"""
Daily-usage accounting that survives a database outage.

check_daily_limit() used to initialise `count = 0`, run a Mongo
count_documents(), and swallow any exception. A read failure therefore
returned "0 used" and every caller got an unlimited allowance — and because
the shared Groq key is ~100 enhancements/day for the whole user base, a single
Atlas free-tier pause could drain the org quota in minutes and surface to
everyone as a total outage.

Failing closed instead is not an improvement on its own: it turns a transient
blip into "nobody can use the product". So Mongo stays authoritative when it
answers, and this module keeps a per-process shadow tally to fall back on.

Scope and limits, stated plainly: the tally lives in this process's memory. The
Space runs a single uvicorn worker with no --workers flag, so today that is the
whole picture. It resets on restart, which is why a degraded read also clamps
to DEGRADED_LIMIT rather than trusting a tally that may have just been born.
Move this to an atomic Mongo $inc on a per-day document before running more
than one worker.
"""

import threading
from datetime import date

_lock = threading.Lock()
_counts: dict = {}          # user_id -> [iso_date, count]

# Ceiling applied when the datastore is unreachable and the shadow tally cannot
# be trusted to be complete (e.g. the process restarted mid-outage).
DEGRADED_LIMIT = 3


def _today() -> str:
    return date.today().isoformat()


def record(user_id: str) -> None:
    """Count one billable enhancement for today."""
    if not user_id:
        return
    today = _today()
    with _lock:
        entry = _counts.get(user_id)
        if entry is None or entry[0] != today:
            _counts[user_id] = [today, 1]
        else:
            entry[1] += 1


def get(user_id: str) -> int:
    """Enhancements this process has seen from this user today."""
    with _lock:
        entry = _counts.get(user_id)
        if entry is None or entry[0] != _today():
            return 0
        return entry[1]


def prune() -> None:
    """Drop entries from previous days. Cheap; safe to call opportunistically."""
    today = _today()
    with _lock:
        for uid in [u for u, e in _counts.items() if e[0] != today]:
            _counts.pop(uid, None)
