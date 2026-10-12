"""
The anonymous tier: an install that has not signed in can rewrite a draft,
Quick only, with no memory, nothing logged, and two caps (per install and
across all anonymous installs). Everything that keeps data needs an account.
"""

import json

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.core.config import settings
from backend.core import usage, ratelimit
from backend.core.database import in_memory_prompt_logs, in_memory_saved_prompts
from backend.core.security import create_jwt_token
from backend.routers import prompts
from backend.services.memory_service import MemoryService


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset():
    def _wipe():
        usage._counts.clear()
        ratelimit._hits.clear()
        in_memory_prompt_logs.clear()
        in_memory_saved_prompts.clear()
    _wipe()
    yield
    _wipe()


@pytest.fixture
def anon(client):
    res = client.post("/auth/anonymous")
    assert res.status_code == 200
    return {"Authorization": f"Bearer {res.json()['token']}"}


@pytest.fixture
def seen(monkeypatch):
    """Fake provider that records what it was asked."""
    calls = []

    def chat(messages, **kw):
        calls.append(messages)
        return {"content": "Rewritten.", "model": "m", "provider": "p", "byok": False}

    def chat_stream(messages, **kw):
        calls.append(messages)
        return iter([{"token": "Rewritten."}, {"meta": {"model": "m", "provider": "p", "byok": False}}])

    monkeypatch.setattr(prompts.providers, "chat", chat)
    monkeypatch.setattr(prompts.providers, "chat_stream", chat_stream)
    return calls


def _events(body):
    return [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ")]


def test_an_anonymous_install_gets_a_quick_rewrite_and_nothing_is_logged(client, anon, seen):
    res = client.post("/enhance", headers=anon, json={
        "prompt": "help me fix my resume", "mode": "deep",
        "conversation_context": ["[user]: SECRET-CONTEXT"],
        "byok_key": "gsk_should_not_be_used",
    })
    assert res.status_code == 200
    body = res.json()
    assert body["enhanced"] == "Rewritten."
    assert body["mode"] == "quick", "anonymous rewrites are Quick only"
    assert body["log_id"] is None
    assert body["usage_today"] == {"used": 1, "limit": settings.ANON_DAILY_LIMIT, "tier": "anon"}
    assert in_memory_prompt_logs == [], "an anonymous draft must not be stored"
    sent = json.dumps(seen[0])
    assert "SECRET-CONTEXT" not in sent, "chat context is not sent for anonymous rewrites"
    assert "MODE: QUICK" in sent


def test_anonymous_rewrites_read_no_memory(client, anon, seen, monkeypatch):
    def boom(*a, **kw):
        raise AssertionError("memory was read for an anonymous user")
    monkeypatch.setattr(MemoryService, "search_saved_prompts", boom)
    monkeypatch.setattr(MemoryService, "retrieve_passive_context", boom)
    monkeypatch.setattr(MemoryService, "get_user_feedback_summary", boom)
    assert client.post("/enhance", headers=anon, json={"prompt": "plan a trip"}).status_code == 200


def test_the_stream_counts_without_logging(client, anon, seen):
    body = client.post("/enhance/stream", headers=anon, json={"prompt": "plan a trip"}).text
    done = next(e for e in _events(body) if e.get("done"))
    assert done["failed"] is False
    assert done["log_id"] is None
    assert done["mode"] == "quick"
    assert done["usage_today"]["used"] == 1
    assert in_memory_prompt_logs == []
    assert client.get("/enhance/usage", headers=anon).json()["count"] == 1


def test_the_per_install_cap_offers_sign_in(client, anon, seen, monkeypatch):
    monkeypatch.setattr(settings, "ANON_DAILY_LIMIT", 2)
    monkeypatch.setitem(settings.TIER_LIMITS, "anon", 2)
    codes = [client.post("/enhance", headers=anon, json={"prompt": "plan a trip"}).status_code
             for _ in range(3)]
    assert codes == [200, 200, 429]
    refusal = client.post("/enhance", headers=anon, json={"prompt": "plan a trip"}).json()
    assert refusal["error"] == "daily_limit_reached"
    assert refusal["sign_in_available"] is True
    assert "Sign in" in refusal["detail"]

    body = client.post("/enhance/stream", headers=anon, json={"prompt": "plan a trip"}).text
    done = next(e for e in _events(body) if e.get("done"))
    assert done["failed"] and done["sign_in_available"], "the stream's done event carries the reason"


def test_the_global_cap_bounds_spend_however_many_tokens_are_minted(client, seen, monkeypatch):
    monkeypatch.setattr(settings, "ANON_GLOBAL_DAILY_LIMIT", 3)
    served = 0
    for _ in range(6):
        token = client.post("/auth/anonymous").json()["token"]
        res = client.post("/enhance", headers={"Authorization": f"Bearer {token}"},
                          json={"prompt": "plan a trip"})
        served += res.status_code == 200
        if res.status_code == 429:
            assert res.json()["error"] == "free_capacity_reached"
    assert served == 3


def test_minting_is_capped_per_address(client, monkeypatch):
    monkeypatch.setattr(settings, "ANON_MINT_PER_HOUR", 2)
    codes = [client.post("/auth/anonymous", headers={"X-Forwarded-For": "1.2.3.4"}).status_code
             for _ in range(3)]
    assert codes == [200, 200, 429]
    assert client.post("/auth/anonymous", headers={"X-Forwarded-For": "5.6.7.8"}).status_code == 200


@pytest.mark.parametrize("method,path", [
    ("get", "/saved-prompts"),
    ("get", "/enhance/history"),
    ("post", "/track"),
])
def test_routes_that_keep_data_need_an_account(client, anon, method, path):
    kwargs = {"json": {"prompt": "x"}} if method == "post" else {}
    res = getattr(client, method)(path, headers=anon, **kwargs)
    assert res.status_code == 403
    assert res.json()["detail"] == "sign_in_required"


def test_an_anonymous_token_cannot_be_refreshed_into_an_account(client):
    token = client.post("/auth/anonymous").json()["token"]
    assert client.post("/auth/refresh", json={"token": token}).status_code == 400


def test_signed_in_users_are_unchanged(client, seen):
    auth = {"Authorization": f"Bearer {create_jwt_token('real-user', 'a@example.com')}"}
    body = client.post("/enhance", headers=auth, json={"prompt": "plan a trip", "mode": "deep"}).json()
    assert body["mode"] == "deep"
    assert body["log_id"]
    assert len(in_memory_prompt_logs) == 1
