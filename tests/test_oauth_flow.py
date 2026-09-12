"""
The Google sign-in handoff, driven end to end against the real app.

The old flow could not complete from the toolbar at all: the popup called
window.open(), which took focus, which destroyed the MV3 action popup — and
with it the postMessage listener that was supposed to receive the token. The
token was also broadcast with targetOrigin "*" and accepted with no origin
check.

Nothing is broadcast now. The callback parks the result and the extension's
service worker — which outlives the popup — collects it once by polling with
the state it started the flow with. These tests exercise that server side.
"""

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.core.config import settings
from backend.routers import auth


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, "GOOGLE_CLIENT_ID", "test-client-id")
    monkeypatch.setattr(settings, "GOOGLE_CLIENT_SECRET", "test-secret")
    auth._oauth_state_store.clear()
    auth._pending_tokens.clear()
    with TestClient(app) as c:
        yield c
    auth._oauth_state_store.clear()
    auth._pending_tokens.clear()


@pytest.fixture
def fake_google(monkeypatch):
    """Stand in for Google's token and userinfo endpoints."""
    class _Res:
        status_code = 200
        text = ""
        def __init__(self, payload): self._payload = payload
        def json(self): return self._payload

    class _Client:
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, data=None): return _Res({"access_token": "ya29.fake"})
        async def get(self, url, headers=None):
            return _Res({"email": "signed-in@example.com", "id": "12345"})

    monkeypatch.setattr(auth.httpx, "AsyncClient", lambda *a, **kw: _Client())


def test_login_returns_a_state_for_the_worker_to_poll_with(client):
    res = client.get("/auth/google/login")
    assert res.status_code == 200
    body = res.json()
    assert body["url"].startswith("https://accounts.google.com/")
    assert body["state"], "no state returned; the worker cannot correlate the flow"
    assert body["state"] in body["url"]


def test_full_handoff_delivers_the_token_once(client, fake_google):
    state = client.get("/auth/google/login").json()["state"]

    # Before Google redirects back, the worker is told to keep waiting.
    assert client.get(f"/auth/google/poll?state={state}").json() == {"status": "pending"}

    callback = client.get(f"/auth/google/callback?code=abc&state={state}")
    assert callback.status_code == 200

    collected = client.get(f"/auth/google/poll?state={state}").json()
    assert collected["status"] == "ready"
    assert collected["email"] == "signed-in@example.com"
    assert collected["token"] and collected["user_id"]

    # Handed over exactly once.
    assert client.get(f"/auth/google/poll?state={state}").json() == {"status": "pending"}


def test_the_delivered_token_actually_authenticates(client, fake_google):
    state = client.get("/auth/google/login").json()["state"]
    client.get(f"/auth/google/callback?code=abc&state={state}")
    token = client.get(f"/auth/google/poll?state={state}").json()["token"]

    res = client.get("/enhance/usage", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200, "the token handed to the extension does not work"


def test_callback_page_does_not_broadcast_the_token(client, fake_google):
    """
    The page used to postMessage the JWT with targetOrigin "*". It must now
    contain no token and no postMessage at all.
    """
    state = client.get("/auth/google/login").json()["state"]
    html = client.get(f"/auth/google/callback?code=abc&state={state}").text

    assert "postMessage" not in html
    assert "window.opener" not in html
    assert "eyJ" not in html, "a JWT was rendered into the callback page"


def test_callback_page_does_not_close_itself(client, fake_google):
    """
    A self-closing page races the worker's poll loop: the worker reads a
    vanished tab as "cancelled", so a page that closed before the next tick
    would report a cancellation for a sign-in that had succeeded.
    """
    state = client.get("/auth/google/login").json()["state"]
    html = client.get(f"/auth/google/callback?code=abc&state={state}").text
    assert "window.close()" not in html.replace(" ", "")


@pytest.mark.parametrize("bad_state", ["", "not-a-real-state", "x" * 43])
def test_callback_rejects_an_unknown_state(client, fake_google, bad_state):
    res = client.get(f"/auth/google/callback?code=abc&state={bad_state}")
    assert res.status_code == 400


def test_state_cannot_be_replayed(client, fake_google):
    state = client.get("/auth/google/login").json()["state"]
    assert client.get(f"/auth/google/callback?code=abc&state={state}").status_code == 200
    assert client.get(f"/auth/google/callback?code=abc&state={state}").status_code == 400


def test_polling_an_unknown_state_reveals_nothing(client):
    assert client.get("/auth/google/poll?state=made-up").json() == {"status": "pending"}


def test_expired_pending_token_is_not_handed_over(client, fake_google, monkeypatch):
    state = client.get("/auth/google/login").json()["state"]
    client.get(f"/auth/google/callback?code=abc&state={state}")

    expiry, payload = auth._pending_tokens[state]
    auth._pending_tokens[state] = (expiry - auth._PENDING_TTL - 1, payload)

    assert client.get(f"/auth/google/poll?state={state}").json() == {"status": "pending"}


def test_login_endpoint_cannot_grow_the_state_store_without_bound(client):
    """
    /auth/google/login is unauthenticated by necessity, so the per-user rate
    limiter cannot protect it. Without a cap, anyone could add entries that live
    for ten minutes each, for as long as they liked.
    """
    auth._oauth_state_store.clear()
    for i in range(auth._MAX_STATES):
        auth._oauth_state_store[f"filler-{i}"] = __import__("time").time() + auth._PENDING_TTL

    res = client.get("/auth/google/login")
    assert res.status_code == 503
    assert len(auth._oauth_state_store) <= auth._MAX_STATES + 1

    auth._oauth_state_store.clear()
    assert client.get("/auth/google/login").status_code == 200
