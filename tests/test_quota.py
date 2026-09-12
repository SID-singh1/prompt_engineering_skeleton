"""
Regression tests for the daily ration.

check_daily_limit() initialised `count = 0`, ran a Mongo count_documents(), and
swallowed every exception. A read failure therefore reported "0 used" and
handed out an UNLIMITED allowance. Because the shared Groq key is roughly 100
enhancements/day across the entire user base, one Atlas hiccup could drain the
org quota within minutes and surface to every user as a total outage.
"""

import pytest

from backend.core import usage
from backend.core.database import MongoDB
from backend.routers import prompts


class _RaisingCollection:
    """A collection whose reads fail, i.e. the outage being defended against."""
    def count_documents(self, *a, **kw):
        raise RuntimeError("connection closed by peer")


class _CountingCollection:
    def __init__(self, count):
        self._count = count

    def count_documents(self, *a, **kw):
        return self._count


@pytest.fixture(autouse=True)
def _clean_state():
    usage._counts.clear()
    original = MongoDB.prompts_col
    yield
    MongoDB.prompts_col = original
    usage._counts.clear()


def test_read_failure_does_not_grant_unlimited_usage():
    """The core regression: a dead datastore must not mean an infinite ration."""
    MongoDB.prompts_col = _RaisingCollection()
    user = "user-outage"

    allowed_count = 0
    for _ in range(50):
        allowed, used, limit, degraded = prompts.check_daily_limit(user, "free")
        if not allowed:
            break
        allowed_count += 1
        assert degraded is True
        usage.record(user)

    assert allowed_count <= usage.DEGRADED_LIMIT, (
        f"granted {allowed_count} enhancements while the store was down"
    )


def test_read_failure_still_serves_something():
    """Failing fully closed would turn a blip into a total outage instead."""
    MongoDB.prompts_col = _RaisingCollection()
    allowed, _, _, degraded = prompts.check_daily_limit("fresh-user", "free")
    assert allowed is True
    assert degraded is True


def test_byok_is_not_clamped_during_an_outage():
    """BYOK users spend their own quota, so a degraded store is no reason to ration them."""
    MongoDB.prompts_col = _RaisingCollection()
    _, _, limit, degraded = prompts.check_daily_limit("byok-user", "byok")
    assert degraded is True
    assert limit > usage.DEGRADED_LIMIT


def test_healthy_store_is_authoritative():
    MongoDB.prompts_col = _CountingCollection(12)
    allowed, used, limit, degraded = prompts.check_daily_limit("u", "free")
    assert (used, degraded) == (12, False)
    assert allowed is (12 < limit)


def test_limit_is_enforced_when_store_is_healthy():
    MongoDB.prompts_col = _CountingCollection(15)
    allowed, used, limit, _ = prompts.check_daily_limit("u", "free")
    assert used == 15 and limit == 15 and allowed is False


def test_shadow_tally_covers_writes_the_store_rejected():
    """
    Mongo accepted no writes but reads fine (a full disk). The stored count
    stays 0 while the in-process tally climbs; the higher one must win.
    """
    MongoDB.prompts_col = _CountingCollection(0)
    user = "u-writes-failing"
    for _ in range(4):
        usage.record(user)
    _, used, _, _ = prompts.check_daily_limit(user, "free")
    assert used == 4


def test_usage_counter_rolls_over_by_day():
    usage.record("u")
    assert usage.get("u") == 1
    usage._counts["u"][0] = "2000-01-01"
    assert usage.get("u") == 0
