import json
from pathlib import Path

from evals.context_retrieval_eval import release_gate, score_results, validate_corpus
from evals.run_context_retrieval_eval import oracle_results


ROOT = Path(__file__).resolve().parents[1]
CASES = ROOT / "evals" / "context_retrieval_cases.json"
HOLDOUT = ROOT / "evals" / "context_retrieval_holdout.json"


def _corpus():
    return json.loads(CASES.read_text(encoding="utf-8"))


def test_holdout_is_independent_and_well_formed():
    calibration = _corpus()
    holdout = json.loads(HOLDOUT.read_text(encoding="utf-8"))
    validate_corpus(holdout)
    assert len(holdout["cases"]) >= 18
    assert len({item["user_id"] for item in holdout["memories"]}) >= 6
    assert {item["user_id"] for item in holdout["memories"]}.isdisjoint(
        {item["user_id"] for item in calibration["memories"]}
    )
    assert {item["id"] for item in holdout["cases"]}.isdisjoint(
        {item["id"] for item in calibration["cases"]}
    )
    assert sum(not case["relevance"] for case in holdout["cases"]) >= 6


def test_retrieval_corpus_covers_people_sources_and_risk_slices():
    corpus = _corpus()
    validate_corpus(corpus)
    assert len(corpus["cases"]) >= 24
    assert len({memory["user_id"] for memory in corpus["memories"]}) >= 6
    assert {memory["source"] for memory in corpus["memories"]} == {"saved", "passive"}
    slices = {case["slice"] for case in corpus["cases"]}
    assert {"abstention", "multi_relevant", "high_stakes", "jurisdiction", "language_memory"} <= slices


def test_oracle_passes_every_release_gate():
    corpus = _corpus()
    report = score_results(corpus, oracle_results(corpus))
    assert release_gate(report["summary"]) == []
    assert report["summary"]["cross_user_leaks"] == 0
    assert report["summary"]["recall_at_k"] == 1.0
    assert report["summary"]["abstention_accuracy"] == 1.0


def test_cross_user_result_is_a_release_blocker():
    corpus = _corpus()
    records = oracle_results(corpus)
    records[0]["retrieved_ids"] = ["priya-pandas"]
    report = score_results(corpus, records)

    assert report["summary"]["cross_user_leaks"] == 1
    assert "cross-user memory leak" in release_gate(report["summary"])


def test_irrelevant_context_breaks_abstention_and_precision():
    corpus = _corpus()
    records = oracle_results(corpus)
    target = next(item for item in records if item["case_id"] == "alex-03")
    target["retrieved_ids"] = ["alex-api"]
    report = score_results(corpus, records)
    detail = next(item for item in report["details"] if item["case_id"] == "alex-03")

    assert detail["abstention_correct"] is False
    assert detail["precision_at_k"] == 0.0
    assert report["summary"]["abstention_accuracy"] < 1.0


def test_missing_results_are_failures_not_silent_skips():
    corpus = _corpus()
    report = score_results(corpus, [])
    assert report["summary"]["results_supplied"] == 0
    assert report["summary"]["recall_at_k"] < 1.0
    assert "incomplete retrieval run" in release_gate(report["summary"])
    assert release_gate(report["summary"])


def test_abstention_does_not_inflate_retrieval_quality():
    corpus = _corpus()
    records = oracle_results(corpus)
    target = next(item for item in records if item["case_id"] == "alex-01")
    target["retrieved_ids"] = []
    summary = score_results(corpus, records)["summary"]

    assert summary["positive_cases"] == 18
    assert summary["abstention_cases"] == 6
    assert summary["recall_at_k"] == round(17 / 18, 4)
    assert summary["abstention_accuracy"] == 1.0


def test_unexpected_memory_id_and_duplicate_case_are_blockers():
    corpus = _corpus()
    records = oracle_results(corpus)
    records[0]["retrieved_ids"] = ["not-a-memory"]
    records.append(records[0].copy())
    summary = score_results(corpus, records)["summary"]

    assert summary["unknown_result_ids"] == 1
    assert summary["duplicate_case_ids"] == 1
    assert "unknown memory result id" in release_gate(summary)
    assert "duplicate case results" in release_gate(summary)


def test_latency_gate_uses_tail_not_only_average():
    corpus = _corpus()
    records = oracle_results(corpus)
    for item in records:
        item["latency_ms"] = 25
    # Two slow cases are enough to enter the worst 5% of this 24-case set.
    records[-1]["latency_ms"] = 2000
    records[-2]["latency_ms"] = 1200
    report = score_results(corpus, records)

    assert report["summary"]["p50_latency_ms"] == 25
    assert report["summary"]["p95_latency_ms"] > 250
    assert "warm p95 retrieval latency above 250 ms" in release_gate(report["summary"])


def test_duplicate_results_are_reported():
    corpus = _corpus()
    records = oracle_results(corpus)
    records[0]["retrieved_ids"] = ["alex-api", "alex-api"]
    report = score_results(corpus, records)
    assert report["summary"]["duplicate_results"] == 1
    assert "duplicate retrieval results" in release_gate(report["summary"])


def test_critical_slice_cannot_hide_behind_a_good_overall_average():
    corpus = _corpus()
    records = oracle_results(corpus)
    target = next(item for item in records if item["case_id"] == "maya-02")
    target["retrieved_ids"] = []
    report = score_results(corpus, records)
    assert "entity_resolution recall@k below 0.75" in release_gate(report["summary"])
