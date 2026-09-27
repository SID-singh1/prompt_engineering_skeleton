import re
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.core import config
from backend.core.config import settings
from backend.core.database import (
    MongoDB,
    QdrantDB,
    in_memory_analytics_events,
    in_memory_prompt_logs,
    in_memory_saved_prompts,
    in_memory_users,
)
from backend.services.analytics_service import AnalyticsService


class _Cursor(list):
    def sort(self, *_args, **_kwargs):
        return self

    def limit(self, count):
        return _Cursor(self[:count])


class _ProjectionCollection:
    """Tiny Mongo stand-in that applies a find projection like MongoDB does."""
    def __init__(self, documents=()):
        self.documents = list(documents)

    def find(self, _query=None, projection=None):
        fields = set((projection or {}).keys())
        return _Cursor([
            {key: value for key, value in doc.items() if key in fields}
            for doc in self.documents
        ])

    def count_documents(self, _query):
        return len(self.documents)


class _FakeDB(dict):
    def __getitem__(self, name):
        return super().get(name, _ProjectionCollection())


@pytest.fixture(autouse=True)
def reset_dashboard_memory():
    """Keep direct service tests isolated from request-level tests."""
    in_memory_analytics_events.clear()
    in_memory_prompt_logs.clear()
    in_memory_saved_prompts.clear()
    in_memory_users.clear()

    yield

    in_memory_analytics_events.clear()
    in_memory_prompt_logs.clear()
    in_memory_saved_prompts.clear()
    in_memory_users.clear()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, "BUILDER_DASHBOARD_KEY", "builder-test-secret")
    with TestClient(app) as test_client:
        yield test_client


def test_dashboard_is_not_available_without_a_configured_key(client, monkeypatch):
    monkeypatch.setattr(settings, "BUILDER_DASHBOARD_KEY", "")
    response = client.get("/builder/dashboard/summary")
    assert response.status_code == 404


def test_no_generated_credential_is_hardcoded_in_the_config():
    """
    Secrets must default to empty. That default is the lock on the builder
    dashboard: _require_builder_key() answers 404 while it is unset, so a
    deployment that forgot the secret exposes nothing. A key written into the
    source is handed to everyone who can read the repository — and to git
    history, which rotating the environment variable cannot reach. One did
    land on main (62a2465); this stops the next one.

    The test looks for something that *is* a credential, not merely a setting
    whose name contains KEY: a long mixed-case alphanumeric string, the shape
    a generator produces. That deliberately clears two neighbours —
    SHARED_KEY_DAILY_LIMIT, which is a number, and JWT_SECRET's
    "unsafedefaultsecret", a placeholder that reads as one and that
    Settings.validate() already refuses to start with in production.

    Checked against the source, not the loaded value: the value is rightly
    non-empty on any machine holding backend/.env, which is gitignored.
    """
    def looks_generated(value: str) -> bool:
        return (
            len(value) >= 16
            and any(c.isdigit() for c in value)
            and any(c.isupper() for c in value)
            and any(c.islower() for c in value)
        )

    offenders = []
    for line in Path(config.__file__).read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        for match in re.finditer(r'os\.getenv\(\s*"([^"]+)"\s*,\s*"([^"]*)"', stripped):
            name, default = match.group(1), match.group(2)
            if looks_generated(default):
                offenders.append(f"{name} defaults to {default[:4]}... in the source")

    assert not offenders, (
        "credentials must come from the environment, never from a default: "
        + "; ".join(offenders)
    )


def test_dashboard_rejects_wrong_key(client):
    response = client.get(
        "/builder/dashboard/summary",
        headers={"X-Builder-Key": "wrong"},
    )
    assert response.status_code == 403


def test_dashboard_returns_aggregate_data_without_prompt_content(client):
    now = datetime.now()
    in_memory_users.update({"one": {"email": "one@example.com"}, "two": {}})
    in_memory_saved_prompts["saved"] = {"user_id": "one", "content": "private saved prompt"}
    in_memory_prompt_logs.extend([
        {
            "user_id": "one",
            "timestamp": now - timedelta(hours=2),
            "source": "active",
            "enhanced": "private enhanced response",
            "original": "private original prompt",
            "latency": 1.2,
            "mode": "deep",
            "platform": "chatgpt.com",
            "provider": "groq",
            "model": "test-model",
            "byok": True,
            "input_method": "voice",
        },
        {
            "user_id": "two",
            "timestamp": now - timedelta(hours=1),
            "source": "passive_tracker",
            "original": "private passive prompt",
        },
    ])
    in_memory_analytics_events.append({
        "event": "failure",
        "operation": "enhance",
        "reason": "provider_unavailable",
        "platform": "claude.ai",
        "mode": "deep",
        "timestamp": now - timedelta(minutes=30),
    })
    in_memory_analytics_events.append({
        "event": "voice_transcribed",
        "operation": "voice_transcribe",
        "duration_seconds": 4.2,
        "transcription_seconds": 0.8,
        "language": "en",
        "timestamp": now - timedelta(minutes=20),
    })

    response = client.get(
        "/builder/dashboard/summary?days=7",
        headers={"X-Builder-Key": "builder-test-secret"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["enhancements"] == 1
    assert body["summary"]["active_users"] == 2
    assert body["summary"]["passive_events"] == 1
    assert body["summary"]["failures"] == 1
    assert body["summary"]["byok_enhancements"] == 1
    assert body["summary"]["voice_enhancements"] == 1
    assert body["summary"]["voice_transcriptions"] == 1
    assert body["summary"]["voice_transcription_failures"] == 0
    assert body["breakdowns"]["platforms"] == {"chatgpt.com": 1}
    assert body["breakdowns"]["input_methods"] == {"voice": 1}
    assert body["failures"][0]["reason"] == "provider_unavailable"
    serialized = response.text
    assert "private original prompt" not in serialized
    assert "private enhanced response" not in serialized
    assert "private passive prompt" not in serialized


def test_dashboard_clamps_requested_window(client):
    response = client.get(
        "/builder/dashboard/summary?days=999",
        headers={"X-Builder-Key": "builder-test-secret"},
    )
    assert response.status_code == 422


def test_mongo_dashboard_path_keeps_user_ids_for_active_user_count(monkeypatch):
    """The production Mongo projection must include user_id, not just the RAM path."""
    now = datetime.now()
    prompts = _ProjectionCollection([
        {"user_id": "one", "timestamp": now, "source": "active", "enhanced": "a", "latency": 1},
        {"user_id": "two", "timestamp": now, "source": "active", "enhanced": "b", "latency": 2},
    ])
    monkeypatch.setattr(MongoDB, "prompts_col", prompts)
    monkeypatch.setattr(MongoDB, "analytics_col", _ProjectionCollection())
    monkeypatch.setattr(MongoDB, "users_col", _ProjectionCollection([{}, {}]))
    monkeypatch.setattr(MongoDB, "saved_prompts_col", _ProjectionCollection())
    monkeypatch.setattr(MongoDB, "db", _FakeDB(prompt_feedback=_ProjectionCollection()))
    monkeypatch.setattr(QdrantDB, "health", lambda: {"connected": True})

    summary = AnalyticsService.summary(7)

    assert summary["summary"]["enhancements"] == 2
    assert summary["summary"]["active_users"] == 2


def test_dashboard_marks_a_bounded_log_sample(monkeypatch):
    now = datetime.now()
    monkeypatch.setattr(MongoDB, "prompts_col", None)
    monkeypatch.setattr(MongoDB, "analytics_col", None)
    monkeypatch.setattr(MongoDB, "users_col", None)
    monkeypatch.setattr(MongoDB, "saved_prompts_col", None)
    monkeypatch.setattr(MongoDB, "db", None)
    monkeypatch.setattr(settings, "DASHBOARD_MAX_LOGS", 1)
    monkeypatch.setattr(QdrantDB, "health", lambda: {"connected": True})
    in_memory_prompt_logs.extend([
        {"user_id": "older", "timestamp": now - timedelta(minutes=1), "source": "active", "enhanced": "a"},
        {"user_id": "newer", "timestamp": now, "source": "active", "enhanced": "b"},
    ])

    summary = AnalyticsService.summary(7)

    assert summary["range"]["logs_truncated"] is True
    assert summary["summary"]["enhancements"] == 1
