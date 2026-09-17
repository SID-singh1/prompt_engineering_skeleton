import json

import httpx
import pytest

from evals.run_context_generation_eval import (
    arm_case, arm_order, main, retry_wait, successful_resume_records,
    summarize, validate_cases,
)
from evals.run_direct_prompt_eval import (
    evaluation_key, messages_for_case, production_constants, provider_request,
)


def _case():
    return {
        "id": "pair-1", "category": "context_personalization", "persona_id": "person_a",
        "input": "write the email", "mode": "quick", "platform": "chatgpt.com", "language": "en",
        "selected_context": [{"title": "Brief", "content": "Target trial users"}],
        "related_saved_prompts": [{"title": "Past", "content": "Target students"}],
        "passive_context": [{"original": "draft email", "refined": "Draft a short email"}],
        "feedback_summary": "Prefer concise writing",
        "conversation_context": ["[user]: Send it on Tuesday"],
        "required_concepts": ["trial users"], "forbidden_concepts": [], "max_words": 30,
    }


def test_none_arm_removes_every_context_layer_without_mutating_fixture():
    case = _case()
    none = arm_case(case, "none")
    controlled = arm_case(case, "controlled")
    constants = production_constants()
    none_prompt = messages_for_case(none, constants)[2]["content"]
    controlled_prompt = messages_for_case(controlled, constants)[2]["content"]
    for marker in ("Target trial users", "Target students", "Draft a short email",
                   "Prefer concise writing", "Send it on Tuesday"):
        assert marker not in none_prompt
        assert marker in controlled_prompt
    assert case["selected_context"]


def test_arm_order_is_counterbalanced():
    assert arm_order(0) == ("none", "controlled")
    assert arm_order(1) == ("controlled", "none")


def test_context_case_validation_rejects_empty_and_duplicate_cases():
    with pytest.raises(ValueError, match="No context"):
        validate_cases([])
    with pytest.raises(ValueError, match="Duplicate"):
        validate_cases([_case(), _case()])
    case = _case()
    case.pop("selected_context")
    for field in ("related_saved_prompts", "passive_context", "feedback_summary", "conversation_context"):
        case.pop(field)
    with pytest.raises(ValueError, match="No controlled context"):
        validate_cases([case])


def test_dry_run_does_not_need_a_key_or_write_output(tmp_path, monkeypatch):
    cases_path = tmp_path / "cases.json"
    cases_path.write_text(json.dumps([_case()]), encoding="utf-8")
    output = tmp_path / "results.jsonl"
    monkeypatch.delenv("PROMPT_EVAL_BYOK_KEY", raising=False)
    assert main(["--cases", str(cases_path), "--dry-run", "--output", str(output)]) == 0
    assert not output.exists()


def test_dry_run_rejects_unknown_case_id(tmp_path):
    cases_path = tmp_path / "cases.json"
    cases_path.write_text(json.dumps([_case()]), encoding="utf-8")
    with pytest.raises(SystemExit):
        main(["--cases", str(cases_path), "--case-id", "missing", "--dry-run"])


def test_paired_run_labels_controlled_context_and_redacts_key(tmp_path, monkeypatch):
    import evals.run_context_generation_eval as runner

    cases_path = tmp_path / "cases.json"
    cases_path.write_text(json.dumps([_case()]), encoding="utf-8")
    output = tmp_path / "results.jsonl"
    monkeypatch.setenv("PROMPT_EVAL_BYOK_KEY", "fake-test-secret")
    calls = []

    def fake_provider_request(**kwargs):
        calls.append(kwargs["messages"][2]["content"])
        return "Write a concise email to trial users.", {"total_tokens": 42}

    monkeypatch.setattr(runner, "provider_request", fake_provider_request)
    assert main(["--cases", str(cases_path), "--delay", "0", "--output", str(output)]) == 0
    records = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
    assert [record["arm"] for record in records] == ["none", "controlled"]
    assert [record["context_source"] for record in records] == ["none", "controlled_fixture"]
    assert "Target trial users" not in calls[0]
    assert "Target trial users" in calls[1]
    assert "fake-test-secret" not in output.read_text(encoding="utf-8")
    assert summarize(records)["controlled"]["completed"] == 1


def test_eval_key_can_be_read_from_ignored_env_file(tmp_path, monkeypatch):
    import evals.run_direct_prompt_eval as direct

    monkeypatch.delenv("PROMPT_EVAL_BYOK_KEY", raising=False)
    monkeypatch.setattr(direct, "ROOT", tmp_path)
    backend = tmp_path / "backend"
    backend.mkdir()
    (backend / ".env").write_text("PROMPT_EVAL_BYOK_KEY=fixture-only-key\n", encoding="utf-8")
    assert evaluation_key() == "fixture-only-key"
    monkeypatch.setenv("PROMPT_EVAL_BYOK_KEY", "process-key")
    assert evaluation_key() == "process-key"


def test_provider_transport_uses_http_client_and_preserves_prompt_shape(monkeypatch):
    import evals.run_direct_prompt_eval as direct

    seen = {}

    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": "Rewrite the email."}}],
                    "usage": {"total_tokens": 9}}

    def fake_post(url, **kwargs):
        seen.update(url=url, **kwargs)
        return FakeResponse()

    monkeypatch.setattr(direct.httpx, "post", fake_post)
    messages = messages_for_case(_case(), production_constants())
    output, usage = provider_request(
        base_url="https://api.groq.com/openai/v1", api_key="fixture-key",
        model="qwen/qwen3.8-27b", messages=messages, temperature=0.5, timeout=15,
    )
    assert output == "Rewrite the email."
    assert usage == {"total_tokens": 9}
    assert seen["url"].endswith("/chat/completions")
    assert seen["headers"]["Authorization"] == "Bearer fixture-key"
    assert seen["json"]["messages"] == messages
    assert seen["json"]["reasoning_effort"] == "none"


def test_retry_wait_honors_provider_advice_and_exponential_floor():
    request = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    response = httpx.Response(429, request=request, text="Please try again in 3.5s.")
    error = httpx.HTTPStatusError("limited", request=request, response=response)
    assert retry_wait(error, 1) == 8.0
    assert retry_wait(error, 2) == 16.0


def test_resume_reuses_only_successful_pairs_and_rejects_wrong_model(tmp_path):
    prior = tmp_path / "prior.jsonl"
    prior.write_text("\n".join(json.dumps(record) for record in [
        {"case_id": "pair-1", "arm": "none", "model": "m", "status_code": 200},
        {"case_id": "pair-1", "arm": "controlled", "model": "m", "status_code": 429},
    ]) + "\n", encoding="utf-8")
    reused = successful_resume_records(prior, [_case()], "m")
    assert set(reused) == {("pair-1", "none")}
    with pytest.raises(ValueError, match="model"):
        successful_resume_records(prior, [_case()], "different-model")


def test_rate_limit_is_retried_without_recording_a_failed_pair(tmp_path, monkeypatch):
    import evals.run_context_generation_eval as runner

    cases_path = tmp_path / "cases.json"
    cases_path.write_text(json.dumps([_case()]), encoding="utf-8")
    output = tmp_path / "results.jsonl"
    monkeypatch.setenv("PROMPT_EVAL_BYOK_KEY", "fixture-key")
    monkeypatch.setattr(runner.time, "sleep", lambda _: None)
    request = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    response = httpx.Response(429, request=request, text="Please try again in 1s.")
    attempts = 0

    def fake_provider_request(**_):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise httpx.HTTPStatusError("limited", request=request, response=response)
        return "Write a concise email to trial users.", {}

    monkeypatch.setattr(runner, "provider_request", fake_provider_request)
    assert main(["--cases", str(cases_path), "--delay", "0", "--output", str(output)]) == 0
    records = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
    assert attempts == 3
    assert len(records) == 2
    assert all(record["status_code"] == 200 for record in records)
