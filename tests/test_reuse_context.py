"""
A retry from the card reuses the earlier rewrite's context, minus what the
user dropped, and goes straight to the model: no saved-prompt search and no
past-pattern search.
"""

import pytest

from backend.models.schemas import EnhanceRequest
from backend.services import prompt_builder
from backend.services.memory_service import MemoryService

SAVED = {
    "a1": {"title": "About me", "content": "I'm a data analyst with 2 years of Python.", "user_id": "u1"},
    "a2": {"title": "Resume style", "content": "Keep it to one page, no tables.", "user_id": "u1"},
    "x9": {"title": "Someone else's", "content": "SECRET", "user_id": "other"},
}


def fetch(pid, user_id):
    doc = SAVED.get(pid)
    return doc if doc and doc["user_id"] == user_id else None


@pytest.fixture
def no_search(monkeypatch):
    def boom(*a, **kw):
        raise AssertionError("retrieval ran on a retry")
    monkeypatch.setattr(MemoryService, "search_saved_prompts", boom)
    monkeypatch.setattr(MemoryService, "retrieve_passive_context", boom)
    monkeypatch.setattr(MemoryService, "get_user_feedback_summary", lambda uid: "")


def build(**kw):
    return prompt_builder._build_enhance_context(EnhanceRequest(prompt="fix my resume", **kw), "u1", fetch)


def test_a_retry_uses_the_kept_context_and_searches_nothing(no_search):
    ctx = build(reuse_context={
        "matched": [{"id": "a1", "score": 0.61}],
        "passive": [{"original": "resume tips", "refined": "Give me three resume tips.", "score": 0.3}],
    })
    assert [s["mongo_id"] for s in ctx["similar_saved"]] == ["a1"]
    assert "I'm a data analyst" in ctx["user_message"]
    assert "Keep it to one page" not in ctx["user_message"], "a dropped match is not sent"
    assert "Give me three resume tips." in ctx["user_message"]
    details = prompt_builder._context_details(ctx)
    assert details["auto_matched_prompts"][0]["id"] == "a1" and details["auto_matched_prompts"][0]["score"] == 0.61
    assert details["passive_patterns"][0]["refined"] == "Give me three resume tips."


def test_dropping_everything_retrieved_sends_none(no_search):
    ctx = build(reuse_context={"matched": [], "passive": []})
    assert ctx["similar_saved"] == [] and ctx["passive_matches"] == []
    assert "RELATED SAVED PROMPTS" not in ctx["user_message"]


def test_a_retry_cannot_reach_another_users_prompt(no_search):
    ctx = build(reuse_context={"matched": [{"id": "x9"}]})
    assert ctx["similar_saved"] == [] and "SECRET" not in ctx["user_message"]


def test_a_retry_carries_no_more_than_retrieval_would(no_search):
    long = "x" * 5000
    ctx = build(reuse_context={
        "matched": [{"id": "a1"}, {"id": "a2"}, {"id": "a1"}, {"id": "a2"}],
        "passive": [{"original": long, "refined": long}] * 5,
    })
    assert len(ctx["similar_saved"]) <= 3
    assert len(ctx["passive_matches"]) == 3
    assert all(len(p["original"]) <= 600 for p in ctx["passive_matches"])


def test_without_reuse_context_retrieval_runs_as_before(monkeypatch):
    calls = []
    monkeypatch.setattr(MemoryService, "search_saved_prompts", lambda **kw: calls.append("saved") or [])
    monkeypatch.setattr(MemoryService, "retrieve_passive_context", lambda **kw: calls.append("passive") or [])
    monkeypatch.setattr(MemoryService, "get_user_feedback_summary", lambda uid: "")
    build()
    assert calls == ["saved", "passive"]


# ── The extension's half ──────────────────────────────────────────────────

import re
from pathlib import Path

CONTENT = (Path(__file__).resolve().parent.parent / "extension" / "content.js").read_text(encoding="utf-8")


def _js(name):
    m = re.search(rf"^(?:async )?function {name}\(", CONTENT, re.M)
    assert m, name
    i = re.compile(r"\)\s*\{").search(CONTENT, m.end()).end() - 1   # the body, past any {} in the parameters
    depth = 0
    for j in range(i, len(CONTENT)):
        depth += {"{": 1, "}": -1}.get(CONTENT[j], 0)
        if depth == 0:
            return CONTENT[i:j + 1]


def test_unticking_context_runs_nothing_until_retry():
    wire = _js("wireCardUsed")
    assert "cardDropPending.add(key)" in wire and "rerun" not in wire.split("pm-card-retry")[0], \
        "a Don't use click only marks the item"
    assert 'getElementById("pm-card-retry")?.addEventListener("click", retryWithoutDropped)' in wire


def test_reruns_send_the_kept_context_back():
    assert "reuseContext: reuseContextFrom(from, excluded, droppedPatterns)" in _js("rerunDraft")
    assert "body.reuse_context = inputMetadata.reuseContext" in _js("enhancePromptStream")
    reuse = _js("reuseContextFrom")
    assert "auto_matched_prompts" in reuse and "passive_patterns" in reuse


def test_a_finished_rewrite_goes_in_the_box_never_over_the_users_edits():
    fin = _js("finalizeStreamingModal")
    assert "fillBoxWith(result)" in fin
    fill = _js("fillBoxWith")
    assert "if (!fillBoxEnabled && !cardInBox) return;" in fill
    assert "norm(before) !== ours" in fill, "never over text the user changed"
    assert "cardBoxBefore = before" in fill, "the exact text is kept for Put mine back"
    assert "restoreComposer(cardBoxBefore)" in _js("putMineBack")


def test_editing_the_rewrite_in_the_box_keeps_it():
    assert "if (stale && cardInBox && !cardWriting) { keepDraft(); return; }" in _js("refreshCardStaleness")
