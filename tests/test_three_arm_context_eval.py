import json
from pathlib import Path

import pytest

from evals.run_three_arm_context_eval import (
    arm_order, case_for_arm, main, oracle_ids, policy_hash, request_hash,
    successful_resume_records, validate_retrieval,
)
from evals.run_direct_prompt_eval import production_constants


ROOT = Path(__file__).resolve().parents[1]
CORPUS = json.loads((ROOT / "evals" / "context_retrieval_holdout.json").read_text(encoding="utf-8"))


def _records():
    return [{"case_id": case["id"], "retrieved_ids": []} for case in CORPUS["cases"]]


def test_three_arm_context_provenance_and_source_shape():
    memories = {item["id"]: item for item in CORPUS["memories"]}
    case = next(item for item in CORPUS["cases"] if item["id"] == "hold-elena-01")
    assert oracle_ids(case) == ["elena-class", "elena-assessment"]
    none, none_ids = case_for_arm(case, memories, ["elena-bakery"], "none")
    oracle, oracle_memory_ids = case_for_arm(case, memories, ["elena-bakery"], "oracle")
    retrieved, retrieved_ids = case_for_arm(case, memories, ["elena-bakery"], "retrieved_local")
    assert none_ids == []
    assert "related_saved_prompts" not in none and "passive_context" not in none
    assert oracle_memory_ids == ["elena-class", "elena-assessment"]
    assert oracle["related_saved_prompts"][0]["content"] == memories["elena-class"]["content"]
    assert oracle["related_saved_prompts"][0]["title"] == ""
    assert oracle["passive_context"][0]["original"] == memories["elena-assessment"]["original"]
    assert retrieved_ids == ["elena-bakery"]
    assert "passive_context" not in retrieved
    assert arm_order(0) != arm_order(1)


def test_cross_user_or_unknown_memory_never_reaches_the_model():
    cases = [next(item for item in CORPUS["cases"] if item["id"] == "hold-nina-01")]
    with pytest.raises(ValueError, match="Cross-user"):
        validate_retrieval(CORPUS, [{"case_id": cases[0]["id"], "retrieved_ids": ["elena-class"]}], cases)
    with pytest.raises(ValueError, match="Unknown"):
        validate_retrieval(CORPUS, [{"case_id": cases[0]["id"], "retrieved_ids": ["missing"]}], cases)
    with pytest.raises(ValueError, match="Missing"):
        validate_retrieval(CORPUS, [], cases)


def test_dry_run_is_keyless_and_writes_nothing(tmp_path, monkeypatch):
    results = tmp_path / "retrieval.jsonl"
    results.write_text("".join(json.dumps(item) + "\n" for item in _records()), encoding="utf-8")
    output = tmp_path / "generated.jsonl"
    monkeypatch.delenv("PROMPT_EVAL_BYOK_KEY", raising=False)
    assert main(["--retrieval-results", str(results), "--limit", "2", "--dry-run", "--output", str(output)]) == 0
    assert not output.exists()


def test_three_arm_run_records_exactly_one_result_per_arm(tmp_path, monkeypatch):
    import evals.run_three_arm_context_eval as runner

    results = tmp_path / "retrieval.jsonl"
    results.write_text("".join(json.dumps(item) + "\n" for item in _records()), encoding="utf-8")
    output = tmp_path / "generated.jsonl"
    monkeypatch.setenv("PROMPT_EVAL_BYOK_KEY", "fixture-secret")
    calls = []

    def provider_request(**kwargs):
        calls.append(kwargs["messages"][2]["content"])
        return "Explain the Cloud Run trade-offs.", {"total_tokens": 30}

    monkeypatch.setattr(runner, "provider_request", provider_request)
    assert main(["--retrieval-results", str(results), "--limit", "1", "--delay", "0", "--output", str(output)]) == 0
    records = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
    assert [item["arm"] for item in records] == ["none", "oracle", "retrieved_local"]
    assert len(calls) == 3
    assert "customer-facing service" not in calls[0]
    assert "customer-facing service" in calls[1]
    assert "customer-facing service" not in calls[2]
    assert "fixture-secret" not in output.read_text(encoding="utf-8")
    assert all(item["max_completion_tokens"] == 768 for item in records)


def test_resume_rejects_output_cap_mismatch(tmp_path):
    case = next(item for item in CORPUS["cases"] if item["id"] == "hold-nina-01")
    memories = {item["id"]: item for item in CORPUS["memories"]}
    retrieved = {case["id"]: []}
    record = {
        "case_id": case["id"], "arm": "none", "model": "fixture-model",
        "policy_hash": policy_hash(production_constants()),
        "input": case["query"], "memory_ids": [],
        "max_completion_tokens": 768, "status_code": 200,
        "request_hash": request_hash(
            case_for_arm(case, memories, [], "none")[0],
            production_constants(), 768,
        ),
    }
    path = tmp_path / "prior.jsonl"
    path.write_text(json.dumps(record) + "\n", encoding="utf-8")
    assert successful_resume_records(
        path, [case], "fixture-model", record["policy_hash"],
        memories, retrieved, 768, production_constants(),
    )[(case["id"], "none")] == record
    with pytest.raises(ValueError, match="differs"):
        successful_resume_records(
            path, [case], "fixture-model", record["policy_hash"],
            memories, retrieved, 1200, production_constants(),
        )


def test_request_hash_changes_when_memory_text_or_title_changes():
    case = next(item for item in CORPUS["cases"] if item["id"] == "hold-sofia-01")
    memories = {item["id"]: dict(item) for item in CORPUS["memories"]}
    ids = oracle_ids(case)
    generation, _ = case_for_arm(case, memories, ids, "oracle")
    first = request_hash(generation, production_constants(), 768)
    memories["sofia-museum"]["title"] = "An invented exhibition name"
    generation, _ = case_for_arm(case, memories, ids, "oracle")
    assert request_hash(generation, production_constants(), 768) != first
