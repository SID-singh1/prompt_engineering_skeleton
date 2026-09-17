import inspect
import json
from collections import Counter
from pathlib import Path

from evals.prompt_eval import score_case
from evals.run_prompt_eval import request_case
from evals.run_direct_prompt_eval import messages_for_case, production_constants, stratified


ROOT = Path(__file__).resolve().parents[1]
CASES_PATH = ROOT / "evals" / "prompt_improvement_cases.json"


def _cases():
    return json.loads(CASES_PATH.read_text(encoding="utf-8"))


def test_prompt_eval_corpus_is_broad_and_well_formed():
    cases = _cases()
    assert len(cases) >= 60
    assert len({case["id"] for case in cases}) == len(cases)

    categories = Counter(case["category"] for case in cases)
    assert len(categories) >= 12
    assert min(categories.values()) >= 3

    modes = Counter(case["mode"] for case in cases)
    assert {"quick", "deep", "creative"} <= modes.keys()
    assert modes["quick"] >= 15 and modes["deep"] >= 20 and modes["creative"] >= 5

    platforms = {case["platform"] for case in cases}
    assert {
        "chatgpt.com", "claude.ai", "gemini.google.com",
        "www.perplexity.ai", "grok.com",
    } <= platforms

    languages = {case["language"] for case in cases}
    assert {"en", "hi", "hi-Latn", "es"} <= languages

    required = {
        "id", "category", "input", "mode", "platform", "language",
        "required_concepts", "forbidden_concepts", "max_words", "intent",
    }
    for case in cases:
        assert required <= case.keys(), case["id"]
        assert isinstance(case["required_concepts"], list)
        assert isinstance(case["forbidden_concepts"], list)
        assert case["max_words"] > 0


def test_deterministic_scorer_accepts_a_compliant_rewrite():
    case = {
        "id": "example", "category": "already_clear",
        "input": "explain tcp vs udp", "max_words": 15, "language": "en",
        "required_concepts": ["TCP", "UDP"], "forbidden_concepts": ["HTTP"],
    }
    score = score_case(case, "Explain the difference between TCP and UDP.")
    assert score.passed


def test_deterministic_scorer_separates_lexical_warnings_from_hard_failures():
    case = {
        "id": "example", "category": "constraint_preservation",
        "input": "compare a and b", "max_words": 4, "language": "en",
        "required_concepts": ["A", "B"], "forbidden_concepts": ["C"],
    }
    score = score_case(case, "Here's the refined prompt: Explain C in excessive detail now.")
    assert not score.passed
    assert any("preamble" in failure for failure in score.failures)
    assert any("required concept" in warning for warning in score.warnings)
    assert any("forbidden concept" in failure for failure in score.failures)
    assert any("too verbose" in failure for failure in score.failures)


def test_exact_literals_are_hard_requirements():
    case = {
        "id": "numbers", "category": "numeric_fidelity",
        "input": "keep 4.2%", "max_words": 10, "language": "en",
        "required_concepts": [], "required_literals": ["4.2%"],
        "forbidden_concepts": [],
    }
    assert score_case(case, "Explain the change from 4.2%.").passed
    assert not score_case(case, "Explain the percentage change.").passed


def test_required_patterns_allow_equivalent_number_spelling():
    case = {
        "id": "numbers", "category": "numeric_fidelity",
        "input": "keep 7", "max_words": 10, "language": "en",
        "required_concepts": [], "required_patterns": [r"\b(?:7|seven)\b"],
        "forbidden_concepts": [],
    }
    assert score_case(case, "Create seven questions.").passed
    assert not score_case(case, "Create eight questions.").passed


def test_romanized_hinglish_switch_to_english_is_flagged_for_review():
    case = {
        "id": "hinglish", "category": "language_fidelity",
        "input": "mujhe pandas interview ke liye plan chahiye",
        "max_words": 30, "language": "hi-Latn", "required_concepts": [],
        "forbidden_concepts": [],
    }
    english = score_case(case, "Create a short Pandas interview study plan.")
    hinglish = score_case(case, "Mujhe Pandas interview ke liye short plan banao.")
    assert any("Hinglish to English" in warning for warning in english.warnings)
    assert not any("Hinglish to English" in warning for warning in hinglish.warnings)


def test_explicitly_forbidding_an_unsafe_phrase_is_not_a_hard_violation():
    case = {
        "id": "negation", "category": "context_personalization",
        "input": "rollout plan", "max_words": 20, "language": "en",
        "required_concepts": [], "forbidden_concepts": ["all customers"],
    }
    safe = score_case(case, "Draft a plan. Do not launch to all customers.")
    revoked = score_case(case, "The previous plan to launch to all customers in October is discarded.")
    unsafe = score_case(case, "Draft a plan to launch to all customers.")
    assert safe.passed
    assert revoked.passed
    assert any("negated forbidden concept" in warning for warning in safe.warnings)
    assert not unsafe.passed


def test_valid_imperative_verbs_are_recognized_as_requests():
    case = {
        "id": "request", "category": "rewriter_not_responder",
        "input": "do the task", "max_words": 10, "language": "en",
        "required_concepts": [], "forbidden_concepts": [],
    }
    for output in ("Generate seven questions.", "Calculate 17 times 23."):
        score = score_case(case, output)
        assert score.passed
        assert "output may not read as a request" not in score.warnings


def test_deterministic_scorer_requires_verbatim_code():
    case = {
        "id": "code", "category": "code_preservation", "input": "debug this",
        "max_words": 20, "language": "en", "required_concepts": [],
        "forbidden_concepts": [], "preserve_verbatim": ["return xs.append(1)"],
    }
    assert score_case(case, "Explain why this returns None: return xs.append(1)").passed
    assert not score_case(case, "Explain why this returns None: return xs + [1]").passed


def test_empty_input_must_be_rejected_before_model_use():
    case = {
        "id": "empty", "category": "degenerate_input", "input": "  ",
        "max_words": 10, "language": "en", "required_concepts": [],
        "forbidden_concepts": [],
    }
    assert not score_case(case, "What would you like help with?", status_code=200).passed
    assert score_case(case, "", status_code=422).passed


def test_live_runner_supports_ephemeral_byok_without_hardcoding_a_key():
    signature = inspect.signature(request_case)
    assert {"byok_provider", "byok_key", "byok_model"} <= signature.parameters.keys()
    source = inspect.getsource(request_case)
    assert "PROMPT_EVAL_BYOK_KEY" not in source


def test_direct_runner_extracts_the_real_production_prompt_shape():
    constants = production_constants()
    case = next(item for item in _cases() if item["id"] == "context-001")
    messages = messages_for_case(case, constants)
    assert [message["role"] for message in messages] == ["system", "assistant", "user"]
    assert constants["OUTPUT_INSTRUCTION"] in messages[0]["content"]
    assert "PostgreSQL on AWS RDS" in messages[2]["content"]
    assert case["input"] in messages[2]["content"]


def test_direct_runner_reproduces_all_personal_context_layers():
    cases = json.loads((ROOT / "evals" / "context_behavior_cases.json").read_text(encoding="utf-8"))
    case = next(item for item in cases if item["id"] == "ctx-source-precedence-012")
    messages = messages_for_case(case, production_constants())
    user_message = messages[2]["content"]
    assert "### USER-SELECTED CONTEXT" in user_message
    assert "Target existing free users" in user_message
    assert "### PAST PROMPT PATTERNS" in user_message
    assert "Target new leads" in user_message


def test_context_behavior_corpus_is_multi_person_and_adversarial():
    cases = json.loads((ROOT / "evals" / "context_behavior_cases.json").read_text(encoding="utf-8"))
    assert len(cases) >= 12
    assert len({case["persona_id"] for case in cases}) >= 8
    assert all(case["category"] == "context_personalization" for case in cases)
    serialized = json.dumps(cases)
    for expected in ("selected_context", "related_saved_prompts", "passive_context", "feedback_summary", "conversation_context"):
        assert expected in serialized
    assert "CROSS_USER_CANARY_7F3A" in serialized


def test_production_prompt_treats_every_context_layer_as_untrusted():
    constants = production_constants()
    system = constants["SYSTEM_PROMPT_BASE"]
    assert "UNTRUSTED DATA" in system
    for layer in ("conversation history", "saved prompts", "passive patterns", "feedback"):
        assert layer in system


def test_production_prompt_prioritizes_current_user_facts_and_language():
    constants = production_constants()
    system = constants["SYSTEM_PROMPT_BASE"]
    deep = constants["MODE_INSTRUCTIONS"]["deep"]
    output = constants["OUTPUT_INSTRUCTION"]
    assert "SOURCE FIDELITY" in system
    assert "latest explicit correction outrank" in system
    assert "do not invent new restrictions" in deep
    assert "Pure English is not a match" in output
    # The old few-shot examples contradicted the rule: they invented an
    # academic domain, a recruiter audience, and an unrequested study plan.
    assert '✅ RIGHT: "Evaluate my recommendation engine idea.' in system
    assert '✅ RIGHT: "Help me make my portfolio website look cool.' in system
    assert "a remembered topic is" in system
    assert "Never fill gaps with speculative variants" in system


def test_stratified_sample_covers_categories_before_repeating_them():
    cases = _cases()
    category_count = len({case["category"] for case in cases})
    sample = stratified(cases, category_count)
    assert len({case["category"] for case in sample}) == category_count


def test_checked_in_chrome_baseline_references_real_cases():
    baseline_path = ROOT / "evals" / "baselines" / "chrome_shared_2026-09-11.json"
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    known_ids = {case["id"] for case in _cases()}
    result_ids = [result["case_id"] for result in baseline["valid_cases"]]
    assert len(result_ids) == len(set(result_ids))
    assert set(result_ids) <= known_ids
    assert all(result["output"].strip() for result in baseline["valid_cases"])
