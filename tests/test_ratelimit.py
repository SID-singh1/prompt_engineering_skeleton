"""
Tests for core.ratelimit.

slowapi has been in requirements.txt and RATE_LIMIT_* in config since the
project started, but nothing ever built a Limiter — every endpoint was
unthrottled.
"""

import pytest

from backend.core import ratelimit


@pytest.fixture(autouse=True)
def _clear():
    ratelimit._hits.clear()
    yield
    ratelimit._hits.clear()


@pytest.mark.parametrize("rule,expected", [
    ("30/minute", (30, 60)),
    ("10/second", (10, 1)),
    ("5/hour",    (5, 3600)),
    ("100/day",   (100, 86400)),
    ("7/minutes", (7, 60)),
])
def test_parse_rule(rule, expected):
    assert ratelimit.parse_rule(rule) == expected


@pytest.mark.parametrize("rule", ["", "nonsense", "abc/minute", "10/fortnight", None])
def test_unparseable_rule_falls_back_rather_than_crashing(rule):
    assert ratelimit.parse_rule(rule) == (30, 60)


def test_requests_are_allowed_up_to_the_limit_then_refused():
    for i in range(5):
        allowed, _ = ratelimit._check("u:a", 5, 60)
        assert allowed, f"request {i + 1} of 5 should have been allowed"

    allowed, retry_after = ratelimit._check("u:a", 5, 60)
    assert allowed is False
    assert retry_after >= 1


def test_buckets_are_isolated_per_key():
    """
    The reason this is keyed on user id, not IP: every request to the Space
    arrives from one proxy address, so an IP-keyed limiter throttles the whole
    user base as a single client.
    """
    for _ in range(5):
        ratelimit._check("enhance:alice", 5, 60)

    allowed, _ = ratelimit._check("enhance:bob", 5, 60)
    assert allowed is True, "bob was throttled by alice's usage"


def test_window_slides(monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(ratelimit.time, "monotonic", lambda: clock["t"])

    for _ in range(3):
        assert ratelimit._check("u:b", 3, 60)[0] is True
    assert ratelimit._check("u:b", 3, 60)[0] is False

    clock["t"] += 61          # the whole window has passed
    assert ratelimit._check("u:b", 3, 60)[0] is True


def test_scopes_do_not_share_a_budget():
    for _ in range(5):
        ratelimit._check("enhance:u", 5, 60)
    assert ratelimit._check("voice:u", 5, 60)[0] is True
