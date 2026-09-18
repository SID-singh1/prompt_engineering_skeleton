"""Fast, deterministic scoring for per-user context retrieval.

Result records are JSON objects with case_id, retrieved_ids in rank order, and
optional latency_ms. Keeping retrieval scoring separate from generation makes
it possible to tell "the right memory was never found" from "the model ignored
the right memory".
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict


def validate_corpus(corpus: dict) -> None:
    memories = corpus.get("memories", [])
    cases = corpus.get("cases", [])
    memory_ids = [item["id"] for item in memories]
    case_ids = [item["id"] for item in cases]
    if len(memory_ids) != len(set(memory_ids)):
        raise ValueError("duplicate memory id")
    if len(case_ids) != len(set(case_ids)):
        raise ValueError("duplicate case id")
    known = set(memory_ids)
    owners = {item["id"]: item["user_id"] for item in memories}
    for case in cases:
        if not set(case["relevance"]) <= known:
            raise ValueError(f"{case['id']} references an unknown memory")
        if any(owners[mid] != case["user_id"] for mid in case["relevance"]):
            raise ValueError(f"{case['id']} marks another user's memory relevant")
        if case.get("k", 0) < 1:
            raise ValueError(f"{case['id']} has invalid k")


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile / 100
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _dcg(grades: list[int]) -> float:
    return sum((2 ** grade - 1) / math.log2(rank + 2) for rank, grade in enumerate(grades))


def score_results(corpus: dict, records: list[dict]) -> dict:
    validate_corpus(corpus)
    memories = {item["id"]: item for item in corpus["memories"]}
    cases = {item["id"]: item for item in corpus["cases"]}
    supplied = {record["case_id"]: record for record in records}
    duplicate_case_ids = len(records) - len(supplied)
    unknown_cases = set(supplied) - set(cases)
    if unknown_cases:
        raise ValueError(f"unknown result cases: {sorted(unknown_cases)}")

    details = []
    latencies = []
    by_slice = defaultdict(list)
    leak_count = 0
    duplicate_count = 0
    unknown_count = 0
    for case_id, case in cases.items():
        record = supplied.get(case_id, {"retrieved_ids": []})
        retrieved = list(record.get("retrieved_ids", []))[: case["k"]]
        duplicate_count += len(retrieved) - len(set(retrieved))
        unknown = [mid for mid in retrieved if mid not in memories]
        unknown_count += len(unknown)
        leaks = [mid for mid in retrieved if mid in memories and memories[mid]["user_id"] != case["user_id"]]
        leak_count += len(leaks)

        relevant = case["relevance"]
        relevant_hits = [mid for mid in retrieved if mid in relevant]
        precision = len(relevant_hits) / len(retrieved) if retrieved else (1.0 if not relevant else 0.0)
        recall = len(set(relevant_hits)) / len(relevant) if relevant else (1.0 if not retrieved else 0.0)
        first = next((rank for rank, mid in enumerate(retrieved, start=1) if mid in relevant), None)
        mrr = 1 / first if first else (1.0 if not relevant and not retrieved else 0.0)
        grades = [int(relevant.get(mid, 0)) for mid in retrieved]
        ideal = sorted((int(value) for value in relevant.values()), reverse=True)[: case["k"]]
        ideal_dcg = _dcg(ideal)
        ndcg = _dcg(grades) / ideal_dcg if ideal_dcg else (1.0 if not retrieved else 0.0)
        abstention_correct = None if relevant else not retrieved
        latency = record.get("latency_ms")
        if isinstance(latency, (int, float)) and latency >= 0:
            latencies.append(float(latency))

        detail = {
            "case_id": case_id,
            "slice": case["slice"],
            "precision_at_k": round(precision, 4),
            "recall_at_k": round(recall, 4),
            "mrr": round(mrr, 4),
            "ndcg_at_k": round(ndcg, 4),
            "abstention_correct": abstention_correct,
            "leaked_ids": leaks,
            "unknown_ids": unknown,
        }
        details.append(detail)
        by_slice[case["slice"]].append(detail)

    def mean(key: str, rows=details):
        values = [row[key] for row in rows]
        return round(statistics.fmean(values), 4) if values else 0.0

    abstention = [row for row in details if row["abstention_correct"] is not None]
    positive = [row for row in details if row["abstention_correct"] is None]
    summary = {
        "cases": len(cases),
        "results_supplied": len(supplied),
        "positive_cases": len(positive),
        "abstention_cases": len(abstention),
        "precision_at_k": mean("precision_at_k", positive),
        "recall_at_k": mean("recall_at_k", positive),
        "mrr": mean("mrr", positive),
        "ndcg_at_k": mean("ndcg_at_k", positive),
        "abstention_accuracy": round(sum(row["abstention_correct"] for row in abstention) / len(abstention), 4) if abstention else None,
        "cross_user_leaks": leak_count,
        "unknown_result_ids": unknown_count,
        "duplicate_case_ids": duplicate_case_ids,
        "duplicate_results": duplicate_count,
        "latency_samples": len(latencies),
        "p50_latency_ms": round(_percentile(latencies, 50), 2) if latencies else None,
        "p95_latency_ms": round(_percentile(latencies, 95), 2) if latencies else None,
        "by_slice": {
            name: {
                "cases": len(rows),
                "positive_cases": len([row for row in rows if row["abstention_correct"] is None]),
                "precision_at_k": mean("precision_at_k", [row for row in rows if row["abstention_correct"] is None]),
                "recall_at_k": mean("recall_at_k", [row for row in rows if row["abstention_correct"] is None]),
                "mrr": mean("mrr", [row for row in rows if row["abstention_correct"] is None]),
            }
            for name, rows in sorted(by_slice.items())
        },
    }
    return {"summary": summary, "details": details}


def release_gate(summary: dict) -> list[str]:
    failures = []
    if summary["results_supplied"] != summary["cases"]:
        failures.append("incomplete retrieval run")
    if summary.get("duplicate_case_ids"):
        failures.append("duplicate case results")
    if summary.get("unknown_result_ids"):
        failures.append("unknown memory result id")
    if summary["cross_user_leaks"]:
        failures.append("cross-user memory leak")
    if summary["duplicate_results"]:
        failures.append("duplicate retrieval results")
    if summary["precision_at_k"] < 0.80:
        failures.append("precision@k below 0.80")
    if summary["recall_at_k"] < 0.85:
        failures.append("recall@k below 0.85")
    if summary["mrr"] < 0.85:
        failures.append("MRR below 0.85")
    if summary["abstention_accuracy"] is not None and summary["abstention_accuracy"] < 0.90:
        failures.append("abstention accuracy below 0.90")
    if summary["p95_latency_ms"] is not None and summary["p95_latency_ms"] > 250:
        failures.append("warm p95 retrieval latency above 250 ms")
    critical_slices = {
        "constraint_memory": 0.60,
        "entity_resolution": 0.75,
        "high_stakes": 0.90,
        "jurisdiction": 0.90,
        "language_memory": 0.90,
        "voice_context": 0.90,
    }
    for name, minimum_recall in critical_slices.items():
        bucket = summary.get("by_slice", {}).get(name)
        if bucket and bucket["recall_at_k"] < minimum_recall:
            failures.append(f"{name} recall@k below {minimum_recall:.2f}")
    return failures
