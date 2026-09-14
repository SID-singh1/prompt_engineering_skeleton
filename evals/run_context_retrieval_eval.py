#!/usr/bin/env python3
"""Validate or score a context-retrieval run without invoking an LLM."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

try:
    from .context_retrieval_eval import release_gate, score_results, validate_corpus
except ImportError:
    from context_retrieval_eval import release_gate, score_results, validate_corpus


HERE = Path(__file__).resolve().parent
DEFAULT_CASES = HERE / "context_retrieval_cases.json"


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def oracle_results(corpus: dict) -> list[dict]:
    return [
        {
            "case_id": case["id"],
            "retrieved_ids": [mid for mid, _ in sorted(case["relevance"].items(), key=lambda item: item[1], reverse=True)][: case["k"]],
            "latency_ms": 1.0,
        }
        for case in corpus["cases"]
    ]


def semantic_local_results(
    corpus: dict, model_name: str, *, saved_threshold: float,
    passive_threshold: float,
) -> list[dict]:
    """Run the production embedding family locally, without Qdrant or user data."""
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as exc:
        raise RuntimeError(
            "sentence-transformers is required for --semantic-local; install backend/requirements.txt"
        ) from exc

    model = SentenceTransformer(model_name)
    memories = corpus["memories"]
    vectors = model.encode(
        [memory["content"] for memory in memories],
        normalize_embeddings=True,
        convert_to_numpy=True,
    )
    by_user = {}
    for index, memory in enumerate(memories):
        by_user.setdefault(memory["user_id"], []).append((memory, vectors[index]))

    records = []
    for case in corpus["cases"]:
        started = time.perf_counter()
        query = model.encode(
            case["query"], normalize_embeddings=True, convert_to_numpy=True
        )
        ranked = sorted(
            (
                (float(query @ vector), memory)
                for memory, vector in by_user.get(case["user_id"], [])
            ),
            key=lambda item: item[0],
            reverse=True,
        )
        # These are the production thresholds in MemoryService. Saved prompts
        # and passive patterns use different collections and cut-offs.
        retrieved = [
            memory["id"] for score, memory in ranked
            if score >= (saved_threshold if memory["source"] == "saved" else passive_threshold)
        ][: case["k"]]
        records.append({
            "case_id": case["id"],
            "retrieved_ids": retrieved,
            "latency_ms": round((time.perf_counter() - started) * 1000, 3),
            "ranked_candidates": [
                {"id": memory["id"], "source": memory["source"], "score": round(float(score), 4)}
                for score, memory in ranked
            ],
        })
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--results", type=Path)
    parser.add_argument("--oracle", action="store_true", help="Score ideal rankings to smoke-test the evaluator")
    parser.add_argument("--semantic-local", action="store_true", help="Run the production multilingual MiniLM embedding locally")
    parser.add_argument("--model", default="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
    parser.add_argument("--saved-threshold", type=float, default=0.24)
    parser.add_argument("--passive-threshold", type=float, default=0.20)
    parser.add_argument("--output", type=Path, help="Write generated retrieval records as JSONL")
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()

    corpus = json.loads(args.cases.read_text(encoding="utf-8"))
    validate_corpus(corpus)
    print(f"Validated {len(corpus['cases'])} cases, {len(corpus['memories'])} memories, and {len({m['user_id'] for m in corpus['memories']})} people.")
    selected_modes = sum(bool(item) for item in (args.results, args.oracle, args.semantic_local))
    if args.validate and not selected_modes:
        return 0
    if selected_modes != 1:
        parser.error("choose exactly one of --results FILE, --oracle, or --semantic-local")

    if args.oracle:
        records = oracle_results(corpus)
    elif args.semantic_local:
        records = semantic_local_results(
            corpus, args.model, saved_threshold=args.saved_threshold,
            passive_threshold=args.passive_threshold,
        )
    else:
        records = read_jsonl(args.results)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
            encoding="utf-8",
        )
    report = score_results(corpus, records)
    failures = release_gate(report["summary"])
    print(json.dumps(report["summary"], indent=2))
    if failures:
        print("Release gate failures: " + "; ".join(failures))
        return 1
    print("Release gates passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
