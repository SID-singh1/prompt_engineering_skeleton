"""
Regression tests for the conversation-context builder.

_build_enhance_context() split scraped messages on a "[user]" prefix. The
extension only emitted that prefix on ChatGPT and Claude — Gemini, Grok, X and
the generic fallback all sent "[message]". On those platforms every scraped
message landed in ai_msgs and exactly ONE of them survived, so six messages of
context silently became one.
"""

import pytest

from backend.models.schemas import EnhanceRequest
from backend.routers.prompts import _build_enhance_context
from backend.services.memory_service import MemoryService


@pytest.fixture(autouse=True)
def _isolate_retrieval(monkeypatch):
    """
    Only the conversation-context branch is under test here. The other context
    layers reach for the embedding model and Qdrant, which are stubbed out in
    conftest and would otherwise dominate this test with unrelated failures.
    """
    monkeypatch.setattr(MemoryService, "search_saved_prompts", staticmethod(lambda **kw: []))
    monkeypatch.setattr(MemoryService, "retrieve_passive_context", staticmethod(lambda **kw: []))
    monkeypatch.setattr(MemoryService, "get_user_feedback_summary", staticmethod(lambda *a, **kw: ""))


def _ctx(messages):
    request = EnhanceRequest(prompt="and then?", conversation_context=messages)
    return _build_enhance_context(request, "test-user")["conversation_ctx"]


def test_tagged_history_keeps_user_turns():
    ctx = _ctx([
        "[user]: how do I read a file in python",
        "[assistant]: use open()",
        "[user]: what about binary mode",
        "[assistant]: pass 'rb'",
    ])
    assert "how do I read a file in python" in ctx
    assert "what about binary mode" in ctx


def test_untagged_history_is_not_collapsed_to_one_message():
    """The regression: platforms whose scraper cannot identify roles."""
    messages = [f"[message]: turn number {i}" for i in range(1, 7)]
    ctx = _ctx(messages)

    kept = [line for line in ctx.splitlines() if line.strip()]
    assert len(kept) > 1, f"untagged history collapsed to {len(kept)} line(s)"
    assert "turn number 6" in ctx


def test_unknown_role_tag_is_also_preserved():
    ctx = _ctx([f"[unknown]: fragment {i}" for i in range(1, 5)])
    assert len([l for l in ctx.splitlines() if l.strip()]) > 1


def test_empty_context_is_harmless():
    assert _ctx([]) == ""
    assert _ctx(None) == ""
