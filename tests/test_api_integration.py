"""
HTTP-layer tests against the real FastAPI app.

Everything else in this suite tests functions in isolation. These boot the
actual application — middleware, dependencies, routers — and drive it through
a TestClient, because several of the fixes live in wiring rather than in logic
and a unit test cannot see them: a middleware that is never registered, a
dependency that is never attached, a CORS flag that is set at construction.

Heavy third-party modules are stubbed in conftest, and MongoDB is unreachable
here, so the app runs on its in-memory fallback — which is itself a path worth
exercising.
"""

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.core.config import settings
from backend.core.security import create_jwt_token
from backend.core import usage, ratelimit
from backend.core.database import (
    in_memory_analytics_events, in_memory_prompt_logs, in_memory_saved_prompts,
    in_memory_users,
)
from backend.routers import prompts


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _reset():
    """
    Mongo is unreachable here so the app uses its in-memory fallback, and those
    module-level stores persist for the whole session. Without clearing them a
    test inherits the previous test's prompt history and reads it as usage.
    """
    def _wipe():
        usage._counts.clear()
        ratelimit._hits.clear()
        in_memory_prompt_logs.clear()
        in_memory_analytics_events.clear()
        in_memory_saved_prompts.clear()
        in_memory_users.clear()

    _wipe()
    yield
    _wipe()


@pytest.fixture
def auth():
    token = create_jwt_token("integration-user", "test@example.com")
    return {"Authorization": f"Bearer {token}"}


# ── body size cap ────────────────────────────────────────────────────────
# A 20 MB unauthenticated POST used to be parsed in full and only then 401'd.

def test_oversized_body_is_refused_before_auth(client):
    oversized = settings.MAX_REQUEST_BYTES + 1
    res = client.post(
        "/enhance",
        content=b"x" * oversized,
        headers={"Content-Type": "application/json"},
    )
    assert res.status_code == 413
    assert res.json()["error"] == "payload_too_large"


def test_normal_body_is_not_refused(client):
    res = client.post("/enhance", json={"prompt": "hello"})
    assert res.status_code != 413      # 401, because there is no token


# ── auth ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("path,method", [
    ("/enhance", "post"),
    ("/enhance/stream", "post"),
    ("/enhance/usage", "get"),
    ("/enhance/history", "get"),
    ("/saved-prompts", "get"),
    ("/track", "post"),
    ("/users/me", "delete"),
])
def test_protected_routes_reject_anonymous_callers(client, path, method):
    kwargs = {"json": {}} if method == "post" else {}
    res = getattr(client, method)(path, **kwargs)
    assert res.status_code in (401, 403), f"{method.upper()} {path} was reachable"


def test_forged_token_is_rejected(client):
    res = client.get("/enhance/usage", headers={"Authorization": "Bearer not.a.jwt"})
    assert res.status_code == 401


def test_health_check_is_public(client):
    assert client.get("/").status_code == 200


# ── CORS ─────────────────────────────────────────────────────────────────
# allow_origins=["*"] with allow_credentials=True made Starlette reflect the
# caller's Origin and permit credentials — the combination the spec forbids.

def test_cors_never_grants_credentials(client):
    res = client.get("/", headers={"Origin": "https://evil.example"})
    assert res.headers.get("access-control-allow-credentials") != "true"


# ── rate limiting ────────────────────────────────────────────────────────
# slowapi sat in requirements and RATE_LIMIT_* in config; nothing built a
# limiter, and 20 rapid requests all sailed through.

def test_enhance_is_rate_limited(client, auth, monkeypatch):
    # Raise the daily ration well clear of the per-minute rule, so what trips
    # here is unambiguously the rate limiter and not the quota.
    monkeypatch.setitem(settings.TIER_LIMITS, "free", 10_000)
    monkeypatch.setattr(
        prompts.providers, "chat",
        lambda **kw: {"content": "rewritten", "model": "m", "provider": "p",
                      "byok": False, "usage": {}, "attempts": [], "truncated": False},
    )

    limit_n, _ = ratelimit.parse_rule(settings.RATE_LIMIT_ENHANCE)
    statuses = [
        client.post("/enhance", json={"prompt": "hello there"}, headers=auth).status_code
        for _ in range(limit_n + 5)
    ]

    assert 429 in statuses, "no request was ever throttled"
    assert statuses.index(429) >= limit_n, "throttled earlier than the configured rule"
    assert "Retry-After" in client.post(
        "/enhance", json={"prompt": "hello"}, headers=auth
    ).headers


def test_rate_limit_is_per_user_not_global(client, monkeypatch):
    monkeypatch.setitem(settings.TIER_LIMITS, "free", 10_000)
    monkeypatch.setattr(
        prompts.providers, "chat",
        lambda **kw: {"content": "ok", "model": "m", "provider": "p",
                      "byok": False, "usage": {}, "attempts": [], "truncated": False},
    )
    limit_n, _ = ratelimit.parse_rule(settings.RATE_LIMIT_ENHANCE)

    alice = {"Authorization": f"Bearer {create_jwt_token('alice', 'a@x.com')}"}
    for _ in range(limit_n + 2):
        client.post("/enhance", json={"prompt": "hi"}, headers=alice)

    bob = {"Authorization": f"Bearer {create_jwt_token('bob', 'b@x.com')}"}
    res = client.post("/enhance", json={"prompt": "hi"}, headers=bob)
    assert res.status_code != 429, "bob was throttled by alice's traffic"


# ── daily ration ─────────────────────────────────────────────────────────

def _stub_llm(monkeypatch):
    monkeypatch.setattr(
        prompts.providers, "chat",
        lambda **kw: {"content": "a rewritten prompt", "model": "m", "provider": "p",
                      "byok": False, "usage": {}, "attempts": [], "truncated": False},
    )


def test_quota_is_enforced_over_real_requests(client, auth, monkeypatch):
    monkeypatch.setitem(settings.TIER_LIMITS, "free", 3)
    _stub_llm(monkeypatch)

    codes = [
        client.post("/enhance", json={"prompt": f"prompt {i}"}, headers=auth).status_code
        for i in range(5)
    ]
    assert codes[:3] == [200, 200, 200]
    assert codes[3] == 429

    body = client.post("/enhance", json={"prompt": "x"}, headers=auth).json()
    assert body["error"] == "daily_limit_reached"
    assert body["byok_available"] is True


def test_quota_does_not_go_infinite_when_the_store_fails(client, auth, monkeypatch):
    """
    The critical regression, over HTTP. A read failure used to report "0 used"
    and grant an unlimited allowance — enough to drain the shared Groq org
    quota, which is ~100 enhancements/day for the entire user base.
    """
    class _Broken:
        def count_documents(self, *a, **kw):
            raise RuntimeError("no reachable servers")

    monkeypatch.setattr(prompts.MongoDB, "prompts_col", _Broken())
    monkeypatch.setitem(settings.TIER_LIMITS, "free", 15)
    _stub_llm(monkeypatch)

    served = sum(
        client.post("/enhance", json={"prompt": f"p{i}"}, headers=auth).status_code == 200
        for i in range(25)
    )
    assert served <= usage.DEGRADED_LIMIT, f"served {served} while the store was down"
    assert served >= 1, "a transient blip must not lock everyone out entirely"


def test_usage_endpoint_agrees_with_what_enhance_enforces(client, auth, monkeypatch):
    """
    The usage bar and the ration used to come from different code paths and
    different tier lookups, so a BYOK user saw 12/15 while the server allowed
    them 1,000.
    """
    monkeypatch.setitem(settings.TIER_LIMITS, "free", 10)
    _stub_llm(monkeypatch)

    for i in range(4):
        client.post("/enhance", json={"prompt": f"p{i}"}, headers=auth)

    reported = client.get("/enhance/usage", headers=auth).json()
    assert reported["count"] == 4
    assert reported["limit"] == 10

    byok = client.get("/enhance/usage?byok=true", headers=auth).json()
    assert byok["tier"] == "byok"
    assert byok["limit"] == settings.TIER_LIMITS["byok"]
    assert byok["limit"] > reported["limit"]


# ── account deletion ─────────────────────────────────────────────────────
# privacy.html promised deletion; no endpoint existed.

def test_account_deletion_removes_the_users_prompt_history(client, auth, monkeypatch):
    _stub_llm(monkeypatch)
    monkeypatch.setitem(settings.TIER_LIMITS, "free", 100)

    client.post("/enhance", json={"prompt": "something personal"}, headers=auth)
    assert client.get("/enhance/history", headers=auth).json()["history"]

    res = client.delete("/users/me", headers=auth)
    assert res.status_code == 200

    assert client.get("/enhance/history", headers=auth).json()["history"] == []


def test_deletion_does_not_touch_another_user(client, monkeypatch):
    _stub_llm(monkeypatch)
    monkeypatch.setitem(settings.TIER_LIMITS, "free", 100)

    a = {"Authorization": f"Bearer {create_jwt_token('keep-me', 'k@x.com')}"}
    b = {"Authorization": f"Bearer {create_jwt_token('delete-me', 'd@x.com')}"}
    client.post("/enhance", json={"prompt": "alice data"}, headers=a)
    client.post("/enhance", json={"prompt": "bob data"}, headers=b)

    client.delete("/users/me", headers=b)

    assert client.get("/enhance/history", headers=a).json()["history"], "wrong user's data was deleted"
    assert client.get("/enhance/history", headers=b).json()["history"] == []


# ── body size caps ────────────────────────────────────────────────────────

def test_voice_uploads_are_allowed_a_larger_body_than_json_routes():
    """
    A flat 2 MB cap would 413 real recordings — ten minutes of 32 kbps opus is
    ~2.3 MB, and five minutes at 64 kbps is the same. Audio needs its own limit.
    """
    assert settings.MAX_AUDIO_BYTES > settings.MAX_REQUEST_BYTES
    ten_min_opus = 10 * 60 * 32_000 / 8
    assert settings.MAX_AUDIO_BYTES > ten_min_opus


def test_json_route_still_rejects_an_oversized_body(client):
    res = client.post("/enhance", content=b"x" * (settings.MAX_REQUEST_BYTES + 1),
                      headers={"Content-Type": "application/json"})
    assert res.status_code == 413


def test_voice_route_does_not_reject_a_body_over_the_json_cap(client):
    """Between the two caps: too big for /enhance, fine for /voice-enhance."""
    size = settings.MAX_REQUEST_BYTES + 1024
    assert size < settings.MAX_AUDIO_BYTES
    res = client.post("/voice-enhance", content=b"x" * size,
                      headers={"Content-Type": "application/octet-stream"})
    assert res.status_code != 413, "a legitimate audio upload was size-rejected"


def test_voice_route_still_has_an_upper_bound(client):
    res = client.post("/voice-enhance", content=b"x" * (settings.MAX_AUDIO_BYTES + 1),
                      headers={"Content-Type": "application/octet-stream"})
    assert res.status_code == 413


# ── voice transcription ──────────────────────────────────────────────────

class _FakeWhisperTranscriptions:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.result


class _FakeWhisperClient:
    def __init__(self, result):
        self.audio = type("Audio", (), {"transcriptions": _FakeWhisperTranscriptions(result)})()


def test_voice_transcription_returns_an_editable_transcript_without_storing_audio_or_text(client, auth, monkeypatch):
    whisper = _FakeWhisperClient({"text": "draft a launch plan", "language": "en"})
    monkeypatch.setattr(prompts, "get_groq_client", lambda _key=None: whisper)

    response = client.post(
        "/voice-transcribe",
        headers=auth,
        data={"platform": "chatgpt.com", "recording_duration_seconds": "7.25"},
        files={"audio": ("recording.webm", b"a" * 200, "audio/webm")},
    )

    assert response.status_code == 200
    assert response.json()["transcription"] == "draft a launch plan"
    assert response.json()["detected_language"] == "en"
    assert whisper.audio.transcriptions.calls[0]["model"] == "whisper-large-v3-turbo"
    assert in_memory_prompt_logs == [], "transcription alone must not create prompt history"
    assert len(in_memory_analytics_events) == 1
    event = in_memory_analytics_events[0]
    assert event["event"] == "voice_transcribed"
    assert event["duration_seconds"] == 7.25
    assert "draft a launch plan" not in str(event)
    assert b"a" * 20 not in str(event).encode()


def test_voice_transcription_rejects_anonymous_uploads(client):
    response = client.post(
        "/voice-transcribe",
        files={"audio": ("recording.webm", b"a" * 200, "audio/webm")},
    )
    assert response.status_code in (401, 403)


def test_voice_transcription_returns_safe_errors_and_records_only_metadata(client, auth):
    response = client.post(
        "/voice-transcribe",
        headers=auth,
        files={"audio": ("recording.webm", b"too short", "audio/webm")},
    )

    assert response.status_code == 422
    assert response.json()["error"] == "audio_too_short"
    assert len(in_memory_analytics_events) == 1
    event = in_memory_analytics_events[0]
    assert event["event"] == "failure"
    assert event["reason"] == "audio_too_short"
    assert "too short" not in str(event)


def test_voice_transcription_hides_provider_errors_and_records_a_reason(client, auth, monkeypatch):
    def unavailable(_key=None):
        raise RuntimeError("provider token=should-never-reach-the-client")

    monkeypatch.setattr(prompts, "get_groq_client", unavailable)
    response = client.post(
        "/voice-transcribe",
        headers=auth,
        files={"audio": ("recording.webm", b"a" * 200, "audio/webm")},
    )

    assert response.status_code == 503
    assert response.json()["error"] == "transcription_unavailable"
    assert "token=" not in response.text
    assert in_memory_analytics_events[0]["reason"] == "transcription_unavailable"


def test_legacy_voice_enhance_stays_compatible_and_marks_voice_input(client, auth, monkeypatch):
    whisper = _FakeWhisperClient({"text": "turn this into a plan", "language": "en"})
    monkeypatch.setattr(prompts, "get_groq_client", lambda _key=None: whisper)
    _stub_llm(monkeypatch)
    monkeypatch.setitem(settings.TIER_LIMITS, "free", 100)

    response = client.post(
        "/voice-enhance",
        headers=auth,
        data={"recording_duration_seconds": "6.5"},
        files={"audio": ("recording.webm", b"a" * 200, "audio/webm")},
    )

    assert response.status_code == 200
    assert response.json()["transcription"] == "turn this into a plan"
    assert in_memory_prompt_logs[0]["input_method"] == "voice"
    assert in_memory_prompt_logs[0]["input_duration_seconds"] == 6.5


def test_voice_input_metadata_is_attached_only_to_the_resulting_enhancement(client, auth, monkeypatch):
    _stub_llm(monkeypatch)
    monkeypatch.setitem(settings.TIER_LIMITS, "free", 100)

    response = client.post(
        "/enhance",
        headers=auth,
        json={
            "prompt": "make a concise plan",
            "input_method": "voice",
            "input_duration_seconds": 8.5,
        },
    )

    assert response.status_code == 200
    assert in_memory_prompt_logs[0]["input_method"] == "voice"
    assert in_memory_prompt_logs[0]["input_duration_seconds"] == 8.5


def test_retention_is_off_unless_explicitly_configured():
    """
    A TTL index deletes on creation. Shipping a non-zero default would have
    destroyed months of live prompt logs on the first boot after deploy.
    """
    assert settings.PROMPT_LOG_TTL_DAYS == 0


def test_both_enhance_endpoints_return_the_same_context_shape(client, auth, monkeypatch):
    """
    /enhance and /enhance/stream do the same work and must describe it the same
    way. They drifted: only the non-streaming one returned context_details, so
    any client feature naming a matched saved prompt had nothing to read on the
    streaming path — which is the path the extension actually uses.
    """
    import json as _json
    monkeypatch.setitem(settings.TIER_LIMITS, "free", 1000)
    _stub_llm(monkeypatch)
    monkeypatch.setattr(
        prompts.providers, "chat_stream",
        lambda **kw: iter([{"token": "rewritten"},
                           {"meta": {"model": "m", "provider": "p", "byok": False}}]),
    )

    plain = client.post("/enhance", json={"prompt": "hello there"}, headers=auth).json()

    streamed = None
    body = client.post("/enhance/stream", json={"prompt": "hello there"}, headers=auth).text
    for line in body.splitlines():
        if line.startswith("data: "):
            payload = _json.loads(line[6:])
            if payload.get("done"):
                streamed = payload

    assert streamed is not None, "stream never produced a done event"
    for key in ("context_used", "context_details", "usage_today", "log_id", "latency"):
        assert key in streamed, f"streaming response is missing {key!r}"
    assert set(plain["context_details"]) == set(streamed["context_details"])
    assert set(plain["context_used"]) == set(streamed["context_used"])
