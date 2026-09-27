"""
What language a rewrite is asked for, and which saved prompts ride along.

Testers saw English prompts come back in romanised Hindi. The router carried a
pasted copy of the prompt builder whose language detector counted "the" and
"me" as Hindi words, so any English prompt with "the" twice was sent with
"Your output MUST be in Hinglish … do NOT translate into pure English". These
tests pin the detector against every labelled eval case, keep the router on the
one builder, and cover the saved-prompt context the card now shows.
"""
import ast
import json
from pathlib import Path

import pytest

from backend.models.schemas import EnhanceRequest
from backend.services import prompt_builder
from backend.services.memory_service import MemoryService
from backend.services.prompt_builder import _build_enhance_context, _context_details, _detect_text_language

ROOT = Path(__file__).resolve().parents[1]

# The two prompts from the tester's screenshots, both rewritten into Hinglish.
SCREENSHOT = (
    "Imagine that tomorrow, every person on Earth wakes up with the ability to remember every conversation "
    "they have ever had perfectly. Analyze how this would change relationships, education, workplaces, politics, "
    "crime, technology, and society over the next 10 years. Identify both unexpected benefits and unintended "
    "consequences, and conclude with one scenario that most people would never anticipate."
)
ENGLISH = [
    SCREENSHOT,
    "fix the bug",
    "help me",
    "tell me the answer",
    "Explain the difference between the two approaches",
    "write me a cover letter for the data analyst role",
    "Can you review this code and tell me what is wrong with the loop",
    "summarise the meeting notes and give me the action items",
    "what is the best way to learn the guitar at home",
]
HINGLISH = [
    "mujhe ek email likhna hai boss ko",
    "kya yeh sahi hai bhai",
    "bhai react app slow kyu hai",
    "isko thoda short karo please",
    "mera resume improve karo but fake experience mat add karna",
]


def _eval_cases():
    data = json.loads((ROOT / "evals" / "prompt_improvement_cases.json").read_text(encoding="utf-8"))
    return data if isinstance(data, list) else data["cases"]


@pytest.mark.parametrize("text", ENGLISH)
def test_english_is_detected_as_english(text):
    assert _detect_text_language(text) == "en"


@pytest.mark.parametrize("text", HINGLISH)
def test_romanised_hinglish_is_still_detected(text):
    assert _detect_text_language(text) == "hi-Latn"


def test_devanagari_is_hindi():
    assert _detect_text_language("मेरे लिए एक योजना बनाओ") == "hi"


def test_every_labelled_eval_case_is_detected_as_labelled():
    """82 human-labelled prompts. Spanish has no detector of its own and reads
    as plain Latin text, which the builder no longer calls English (below)."""
    wrong = []
    for case in _eval_cases():
        want = {"es": "en"}.get(case["language"], case["language"])
        got = _detect_text_language(case["input"])
        if got != want:
            wrong.append((case["id"], case["language"], got, case["input"][:60]))
    assert not wrong, wrong


# ── one builder ─────────────────────────────────────────────────────────

def test_the_router_carries_no_copy_of_the_builder():
    """The Hinglish bug was a pasted copy that drifted. Fail if one comes back."""
    tree = ast.parse((ROOT / "backend" / "routers" / "prompts.py").read_text(encoding="utf-8"))
    defined = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    assigned = {t.id for n in tree.body if isinstance(n, ast.Assign) for t in n.targets if isinstance(t, ast.Name)}
    copies = ({"_detect_text_language", "_conversation_context", "_llm_messages", "_temperature_for"} & defined) | (
        {"SYSTEM_PROMPT_BASE", "MODE_INSTRUCTIONS", "PLATFORM_HINTS", "LANGUAGE_NAMES",
         "OUTPUT_INSTRUCTION", "STEERING_TURN"} & assigned)
    assert not copies, f"routers/prompts.py redefines {sorted(copies)}; import them from prompt_builder"


def test_the_router_uses_the_builders_detector():
    from backend.routers import prompts
    assert prompts._detect_text_language is prompt_builder._detect_text_language


# ── what the model is told ──────────────────────────────────────────────

@pytest.fixture
def saved(monkeypatch):
    """Stand-ins for the vector store and the other memory layers."""
    state = {"results": [], "calls": []}

    def search(**kw):
        state["calls"].append(kw)
        return [dict(r) for r in state["results"]]

    monkeypatch.setattr(MemoryService, "search_saved_prompts", staticmethod(search))
    monkeypatch.setattr(MemoryService, "retrieve_passive_context", staticmethod(lambda **kw: []))
    monkeypatch.setattr(MemoryService, "get_user_feedback_summary", staticmethod(lambda *a, **kw: ""))
    return state


def _ctx(prompt, fetch=None, **fields):
    return _build_enhance_context(EnhanceRequest(prompt=prompt, **fields), "u1", fetch)


@pytest.mark.parametrize("text", [SCREENSHOT, "fix the bug", "help me"])
def test_english_prompts_are_never_told_to_answer_in_hinglish(saved, text):
    message = _ctx(text)["user_message"]
    assert "Hinglish" not in message
    assert "SCRIPT REQUIREMENT" not in message
    assert "same language as the USER'S PROMPT" in message


def test_hinglish_prompts_keep_their_script(saved):
    message = _ctx("mujhe ek email likhna hai boss ko")["user_message"]
    assert "MUST be in **Hinglish" in message
    assert "SCRIPT REQUIREMENT" in message


def test_spanish_is_not_translated_into_english(saved):
    message = _ctx("Compara estas dos propuestas y dime cuál tiene menos riesgo")["user_message"]
    assert "**English**" not in message
    assert "Do NOT translate it" in message


def test_whisper_language_is_named_explicitly(saved):
    """Voice already knows its language; that positive evidence is used as is."""
    message = _ctx("the report from last week", source_language="en")["user_message"]
    assert "MUST be in **English**" in message


# ── saved prompts that ride along ───────────────────────────────────────

def _hit(pid, content, score=0.5, title=""):
    return {"mongo_id": pid, "content": content, "title": title or pid, "tags": [], "score": score}


def test_dropped_and_attached_prompts_are_not_searched(saved):
    fetch = lambda pid, uid: {"title": "Attached", "content": "attached text"}
    _ctx("plan a launch", fetch, selected_prompt_ids=["a1"], excluded_prompt_ids=["x1", "x2"])
    assert set(saved["calls"][0]["exclude_ids"]) == {"a1", "x1", "x2"}


def test_a_saved_prompt_already_in_the_draft_is_not_sent_back(saved):
    """// inserts a saved prompt; it then matches itself almost perfectly."""
    review = "Review this diff like a senior engineer: correctness first, then naming, then tests."
    saved["results"] = [_hit("s1", review, 0.81), _hit("s2", "Bug triage: rank root causes.", 0.4)]
    ctx = _ctx(f"Here's the diff for the checkout refactor. {review}")
    assert [s["mongo_id"] for s in ctx["similar_saved"]] == ["s2"]
    assert "correctness first" not in ctx["user_message"].split("### RELATED SAVED PROMPTS")[-1].split("### USER'S PROMPT")[0]


def test_a_near_identical_match_is_not_sent_back(saved):
    saved["results"] = [_hit("s1", "something worded a bit differently", 0.98), _hit("s2", "other", 0.5)]
    assert [s["mongo_id"] for s in _ctx("anything")["similar_saved"]] == ["s2"]


def test_short_saved_prompts_are_not_dropped_for_a_common_phrase(saved):
    """Containment only counts for real prompt text, not a two-word title."""
    saved["results"] = [_hit("s1", "fix it", 0.5)]
    assert len(_ctx("please fix it now")["similar_saved"]) == 1


def test_context_details_name_every_saved_prompt_with_its_id(saved):
    saved["results"] = [_hit("s2", "Bug triage: rank root causes.", 0.44, title="Bug triage")]
    fetch = lambda pid, uid: {"title": "Code review", "content": "Review this diff like a senior engineer."}
    details = _context_details(_ctx("the login page crashes", fetch, selected_prompt_ids=["a1"]))
    assert details["selected_prompts"] == [{"id": "a1", "title": "Code review", "content": "Review this diff like a senior engineer."}]
    assert details["auto_matched_prompts"] == [
        {"id": "s2", "title": "Bug triage", "content": "Bug triage: rank root causes.", "score": 0.44}]
