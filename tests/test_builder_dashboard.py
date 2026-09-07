from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.core.config import settings
from backend.core.database import (
    in_memory_analytics_events,
    in_memory_prompt_logs,
    in_memory_saved_prompts,
    in_memory_users,
)


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, "BUILDER_DASHBOARD_KEY", "builder-test-secret")
    in_memory_analytics_events.clear()
    in_memory_prompt_logs.clear()
    in_memory_saved_prompts.clear()
    in_memory_users.clear()
    with TestClient(app) as test_client:
        yield test_client
    in_memory_analytics_events.clear()
    in_memory_prompt_logs.clear()
    in_memory_saved_prompts.clear()
    in_memory_users.clear()


def test_dashboard_is_not_available_without_a_configured_key(client, monkeypatch):
    monkeypatch.setattr(settings, "BUILDER_DASHBOARD_KEY", "")
    response = client.get("/builder/dashboard/summary")
    assert response.status_code == 404


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
    assert body["breakdowns"]["platforms"] == {"chatgpt.com": 1}
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
