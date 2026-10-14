"""
The shared server chain's capacity: an optional rung after Groq, and what
each shared key has left.

Keys are about to come off the first setup page, so every tester's rewrite
goes through the shared keys. The four Groq rungs all draw on one Groq
organisation; SERVER_EXTRA_MODELS adds a rung on another provider for the
day that is spent, and the x-ratelimit-* headers say how close that day is.
"""
import json

import pytest

from backend.core.config import settings
from backend.services import providers


class _Res:
    def __init__(self, status=200, content="A clear rewrite.", headers=None, body=""):
        self.status_code = status
        self.headers = headers or {}
        self._content = content
        self.text = body

    def json(self):
        return {"choices": [{"message": {"content": self._content}, "finish_reason": "stop"}], "usage": {}}


class _StreamRes(_Res):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self.text.encode()

    def iter_lines(self):
        if self.status_code != 200:
            return iter(())
        chunk = {"choices": [{"delta": {"content": self._content}}]}
        return iter([f"data: {json.dumps(chunk)}", "data: [DONE]"])


class _Client:
    """Answers by host: each test says what Groq and Gemini reply."""
    def __init__(self, groq, gemini):
        self.replies = {"api.groq.com": groq, "generativelanguage.googleapis.com": gemini}
        self.calls = []

    def _reply(self, url, kind):
        host = url.split("/")[2]
        self.calls.append((host, url))
        make = self.replies[host]
        return make(kind)

    def post(self, url, headers=None, json=None, timeout=None):
        return self._reply(url, _Res)

    def stream(self, method, url, headers=None, json=None, timeout=None):
        return self._reply(url, _StreamRes)


RATE_LIMITED = lambda kind: kind(429, body="rate_limit_exceeded: Requests per day", headers={
    "x-ratelimit-remaining-requests": "0", "x-ratelimit-limit-requests": "1000", "retry-after": "60"})
GEMINI_OK = lambda kind: kind(200, content="Gemini's rewrite.")
GROQ_OK = lambda kind: kind(200, content="Groq's rewrite.", headers={
    "x-ratelimit-remaining-requests": "987", "x-ratelimit-limit-requests": "1000",
    "x-ratelimit-remaining-tokens": "7400", "x-ratelimit-limit-tokens": "8000",
    "x-ratelimit-reset-requests": "1m12s", "x-ratelimit-reset-tokens": "4.5s"})


@pytest.fixture(autouse=True)
def clean_pool(monkeypatch):
    providers._key_cooldowns.clear()
    providers._dead_models.clear()
    providers._headroom.clear()
    monkeypatch.setattr(settings, "GROQ_API_KEY", "gsk_shared_1", raising=False)
    monkeypatch.setattr(settings, "GROQ_API_KEY_2", None, raising=False)
    monkeypatch.setattr(settings, "GEMINI_API_KEY", None, raising=False)
    monkeypatch.setattr(settings, "SERVER_EXTRA_MODELS", "", raising=False)
    yield
    providers._key_cooldowns.clear()
    providers._dead_models.clear()
    providers._headroom.clear()


def _use(monkeypatch, client):
    monkeypatch.setattr(providers, "_client", lambda: client)
    return client


def test_with_nothing_configured_the_chain_is_exactly_the_groq_one():
    assert providers.server_chain() == providers.DEFAULT_CHAIN
    labels = [spec.label for spec, _ in providers._resolve_chain(None, None, None)]
    assert labels == [m.label for m in providers.DEFAULT_CHAIN]
    assert all(m.provider == "groq" for m in providers.server_chain())


def test_extra_models_follow_the_groq_rungs_and_bad_entries_are_ignored(monkeypatch):
    monkeypatch.setattr(settings, "SERVER_EXTRA_MODELS",
                        " gemini:gemini-3.5-flash-lite , nonsense, mystery:model-x, groq: ,", raising=False)
    chain = providers.server_chain()
    assert chain[:len(providers.DEFAULT_CHAIN)] == providers.DEFAULT_CHAIN
    assert [m.label for m in chain[len(providers.DEFAULT_CHAIN):]] == ["gemini/gemini-3.5-flash-lite"]
    assert chain[-1].params == {"max_completion_tokens": 1200}, "plain params: a Groq-only one is a 400 elsewhere"


def test_when_groq_is_spent_the_extra_rung_answers(monkeypatch):
    monkeypatch.setattr(settings, "SERVER_EXTRA_MODELS", "gemini:gemini-3.5-flash-lite", raising=False)
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "AIza_shared", raising=False)
    client = _use(monkeypatch, _Client(groq=RATE_LIMITED, gemini=GEMINI_OK))
    out = providers.chat([{"role": "user", "content": "hi"}])
    assert out["content"] == "Gemini's rewrite." and out["provider"] == "gemini" and not out["byok"]
    assert [h for h, _ in client.calls].count("api.groq.com") == len(providers.DEFAULT_CHAIN)
    assert all("rate_limit" in why for _, why in out["attempts"])


def test_the_stream_falls_through_to_the_extra_rung_too(monkeypatch):
    monkeypatch.setattr(settings, "SERVER_EXTRA_MODELS", "gemini:gemini-3.5-flash-lite", raising=False)
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "AIza_shared", raising=False)
    _use(monkeypatch, _Client(groq=RATE_LIMITED, gemini=GEMINI_OK))
    events = list(providers.chat_stream([{"role": "user", "content": "hi"}]))
    assert "".join(e.get("token", "") for e in events) == "Gemini's rewrite."
    assert events[-1]["meta"]["provider"] == "gemini"


def test_an_extra_rung_without_its_key_is_skipped_not_called(monkeypatch):
    monkeypatch.setattr(settings, "SERVER_EXTRA_MODELS", "gemini:gemini-3.5-flash-lite", raising=False)
    client = _use(monkeypatch, _Client(groq=RATE_LIMITED, gemini=GEMINI_OK))
    with pytest.raises(providers.NoProviderAvailable) as err:
        providers.chat([{"role": "user", "content": "hi"}])
    assert ("gemini/gemini-3.5-flash-lite", "no API key configured") in err.value.attempts
    assert all(host == "api.groq.com" for host, _ in client.calls)


def test_a_shared_keys_headroom_is_kept_from_its_headers(monkeypatch):
    _use(monkeypatch, _Client(groq=GROQ_OK, gemini=GEMINI_OK))
    providers.chat([{"role": "user", "content": "hi"}])
    first = providers.DEFAULT_CHAIN[0].label
    seen = providers.pool_status()["headroom"][first]["0"]
    assert seen["requests_left"] == 987 and seen["requests_limit"] == 1000
    assert seen["tokens_left"] == 7400 and seen["tokens_limit"] == 8000
    assert seen["requests_reset"] == "1m12s" and isinstance(seen["at"], int)


def test_the_stream_keeps_headroom_as_well(monkeypatch):
    _use(monkeypatch, _Client(groq=GROQ_OK, gemini=GEMINI_OK))
    list(providers.chat_stream([{"role": "user", "content": "hi"}]))
    assert providers.pool_status()["headroom"][providers.DEFAULT_CHAIN[0].label]["0"]["requests_left"] == 987


def test_a_users_own_key_is_never_recorded_as_ours(monkeypatch):
    _use(monkeypatch, _Client(groq=GROQ_OK, gemini=GEMINI_OK))
    providers.chat([{"role": "user", "content": "hi"}], user_provider="groq", user_key="gsk_users_own")
    assert providers.pool_status()["headroom"] == {}


def test_pool_status_names_the_chain_and_its_extras(monkeypatch):
    monkeypatch.setattr(settings, "SERVER_EXTRA_MODELS", "gemini:gemini-3.5-flash-lite", raising=False)
    status = providers.pool_status()
    assert status["chain"][-1] == "gemini/gemini-3.5-flash-lite"
    assert status["extra_models"] == ["gemini/gemini-3.5-flash-lite"]
    assert "headroom" in status
