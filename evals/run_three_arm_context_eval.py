#!/usr/bin/env python3
"""Held-out three-arm rewrite evaluation using synthetic, per-user memories.

Arms: no memory, human-labeled relevant memory, locally retrieved memory.
The third arm is NOT the live Qdrant/API path. It uses an input JSONL from
run_context_retrieval_eval.py; report it as `retrieved_local` only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

try:
    from .context_retrieval_eval import validate_corpus
    from .prompt_eval import score_case
    from .run_context_generation_eval import retry_wait
    from .run_direct_prompt_eval import (
        HERE, evaluation_key, messages_for_case, production_constants,
        provider_request,
    )
except ImportError:
    from context_retrieval_eval import validate_corpus
    from prompt_eval import score_case
    from run_context_generation_eval import retry_wait
    from run_direct_prompt_eval import (
        HERE, evaluation_key, messages_for_case, production_constants,
        provider_request,
    )


DEFAULT_CORPUS = HERE / "context_retrieval_holdout.json"
ARMS = ("none", "oracle", "retrieved_local")
TEMPERATURES = {"quick": 0.5, "deep": 0.6, "creative": 0.7}


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]


def validate_retrieval(corpus: dict, records: list[dict], selected: list[dict]) -> dict[str, list[str]]:
    """Reject incomplete/unsafe retrieval before any memory reaches a model."""
    memories = {item["id"]: item for item in corpus["memories"]}
    cases = {case["id"]: case for case in selected}
    mapping = {}
    for record in records:
        case_id = record.get("case_id")
        if case_id not in cases:
            continue
        if case_id in mapping:
            raise ValueError(f"Duplicate retrieval result: {case_id}")
        ids = record.get("retrieved_ids", [])
        if not isinstance(ids, list) or len(ids) != len(set(ids)):
            raise ValueError(f"Invalid or duplicate retrieved IDs: {case_id}")
        if len(ids) > cases[case_id]["k"]:
            raise ValueError(f"Too many retrieved IDs: {case_id}")
        for memory_id in ids:
            if memory_id not in memories:
                raise ValueError(f"Unknown retrieved memory: {memory_id}")
            if memories[memory_id]["user_id"] != cases[case_id]["user_id"]:
                raise ValueError(f"Cross-user retrieved memory blocked: {case_id}")
        mapping[case_id] = ids
    if set(mapping) != set(cases):
        raise ValueError(f"Missing retrieval results: {sorted(set(cases) - set(mapping))}")
    return mapping


def oracle_ids(case: dict) -> list[str]:
    return [memory_id for memory_id, _ in sorted(
        case["relevance"].items(), key=lambda item: item[1], reverse=True,
    )][:case["k"]]


def case_for_arm(case: dict, memory_by_id: dict, retrieved_ids: list[str], arm: str) -> tuple[dict, list[str]]:
    if arm not in ARMS:
        raise ValueError(f"Unknown arm: {arm}")
    ids = [] if arm == "none" else oracle_ids(case) if arm == "oracle" else retrieved_ids
    generation_case = {
        "id": case["id"], "category": "context_personalization",
        "input": case["query"], "mode": case.get("mode", "deep"),
        "platform": case.get("platform", "chatgpt.com"),
        "language": case.get("language", "en"),
        # This suite has no manually adjudicated length cap. Record length for
        # review rather than inventing a hard gate that rewards shortness.
        "max_words": 999, "required_concepts": [], "forbidden_concepts": [],
    }
    saved = []
    passive = []
    for memory_id in ids:
        memory = memory_by_id[memory_id]
        if memory["user_id"] != case["user_id"]:
            raise ValueError(f"Cross-user memory blocked: {memory_id}")
        if memory["source"] == "saved":
            # The synthetic id is bookkeeping, not a user-authored title. It
            # must never be shown to the model as one (e.g. "sofia-museum"
            # becomes a fabricated exhibition name).
            saved.append({"title": memory.get("title", ""), "content": memory["content"]})
        elif memory["source"] == "passive":
            if not memory.get("original") or not memory.get("refined"):
                raise ValueError(f"Passive memory lacks production-shaped pattern: {memory_id}")
            passive.append({"original": memory["original"], "refined": memory["refined"]})
        else:
            raise ValueError(f"Unknown memory source: {memory['source']}")
    if saved:
        generation_case["related_saved_prompts"] = saved
    if passive:
        generation_case["passive_context"] = passive
    return generation_case, ids


def arm_order(index: int) -> tuple[str, str, str]:
    return ARMS[index % 3:] + ARMS[:index % 3]


def policy_hash(constants: dict) -> str:
    return hashlib.sha256(json.dumps(constants, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def request_hash(generation_case: dict, constants: dict, max_completion_tokens: int) -> str:
    params = {
        "messages": messages_for_case(generation_case, constants),
        "temperature": TEMPERATURES.get(generation_case["mode"], 0.6),
        "max_completion_tokens": max_completion_tokens,
    }
    return hashlib.sha256(json.dumps(params, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()


def successful_resume_records(
    path: Path, cases: list[dict], model: str, prompt_hash: str,
    memories: dict, retrieved: dict[str, list[str]], max_completion_tokens: int,
    constants: dict,
) -> dict[tuple[str, str], dict]:
    cases_by_id = {case["id"]: case for case in cases}
    previous = {}
    for record in read_jsonl(path):
        case_id, arm = record.get("case_id"), record.get("arm")
        if case_id not in cases_by_id or arm not in ARMS:
            continue
        case = cases_by_id[case_id]
        generation_case, expected_ids = case_for_arm(case, memories, retrieved[case_id], arm)
        if (record.get("model") != model
                or record.get("policy_hash") != prompt_hash
                or record.get("max_completion_tokens") != max_completion_tokens
                or record.get("input") != case["query"]
                or record.get("memory_ids") != expected_ids
                or record.get("request_hash") != request_hash(
                    generation_case, constants, max_completion_tokens,
                )):
            raise ValueError(f"Resume result differs from current case/policy/model: {case_id} {arm}")
        if record.get("status_code") == 200:
            previous[(case_id, arm)] = record
    return previous


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument("--retrieval-results", type=Path, required=True)
    parser.add_argument("--case-id", action="append", default=[])
    parser.add_argument("--limit", type=int)
    parser.add_argument("--delay", type=float, default=25.0)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--max-completion-tokens", type=int, default=768)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--resume-from", type=Path, help="Reuse successful same-policy arms from an earlier JSONL")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    if args.delay < 0 or args.timeout <= 0:
        parser.error("--delay must be nonnegative and --timeout positive")
    if args.max_completion_tokens < 1:
        parser.error("--max-completion-tokens must be positive")

    corpus = json.loads(args.cases.read_text(encoding="utf-8"))
    validate_corpus(corpus)
    cases = corpus["cases"]
    if args.case_id:
        wanted = set(args.case_id)
        known = {case["id"] for case in cases}
        if wanted - known:
            parser.error(f"Unknown case IDs: {sorted(wanted - known)}")
        cases = [case for case in cases if case["id"] in wanted]
    if args.limit is not None:
        cases = cases[:args.limit]
    if not cases:
        parser.error("no cases selected")
    retrieved = validate_retrieval(corpus, read_jsonl(args.retrieval_results), cases)
    memories = {item["id"]: item for item in corpus["memories"]}
    constants = production_constants()
    for case in cases:
        for arm in ARMS:
            generation_case, _ = case_for_arm(case, memories, retrieved[case["id"]], arm)
            messages_for_case(generation_case, constants)
    print(f"Validated {len(cases)} held-out cases, {3 * len(cases)} three-arm calls.")
    print("The retrieved arm uses LOCAL embedding results, not production Qdrant.")
    if args.dry_run:
        return 0

    key = evaluation_key()
    if not key:
        print("PROMPT_EVAL_BYOK_KEY is required.", file=sys.stderr)
        return 2
    base_url = os.getenv("PROMPT_EVAL_PROVIDER_URL", "https://api.groq.com/openai/v1").strip()
    model = os.getenv("PROMPT_EVAL_BYOK_MODEL", "qwen/qwen3.8-27b").strip()
    prompt_hash = policy_hash(constants)
    output = args.output or (
        HERE / "results" / f"three-arm-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.jsonl"
    )
    if args.resume_from and output.resolve() == args.resume_from.resolve():
        parser.error("--output must differ from --resume-from")
    reused = successful_resume_records(
        args.resume_from, cases, model, prompt_hash, memories, retrieved,
        args.max_completion_tokens, constants,
    ) if args.resume_from else {}
    if reused:
        print(f"Reusing {len(reused)} successful arms; requesting {3 * len(cases) - len(reused)}.")
    output.parent.mkdir(parents=True, exist_ok=True)
    records = []
    total = 3 * len(cases)
    with output.open("w", encoding="utf-8") as handle:
        for index, case in enumerate(cases):
            for position, arm in enumerate(arm_order(index)):
                sequence = 3 * index + position + 1
                generation_case, ids = case_for_arm(case, memories, retrieved[case["id"]], arm)
                prior = reused.get((case["id"], arm))
                if prior is not None:
                    records.append(prior)
                    handle.write(json.dumps(prior, ensure_ascii=False) + "\n")
                    print(f"[{sequence:02}/{total:02}] {case['id']} {arm} reused HTTP 200", flush=True)
                    continue
                started = time.monotonic()
                status, enhanced, usage, error = 200, "", {}, ""
                for attempt in range(1, 5):
                    try:
                        enhanced, usage = provider_request(
                            base_url=base_url, api_key=key, model=model,
                            messages=messages_for_case(generation_case, constants),
                            temperature=TEMPERATURES.get(generation_case["mode"], 0.6),
                            timeout=args.timeout,
                            max_completion_tokens=args.max_completion_tokens,
                        )
                        status, error = 200, ""
                        break
                    except httpx.HTTPStatusError as exc:
                        status, error = exc.response.status_code, exc.response.text[:500]
                        if status == 429 and attempt < 4:
                            wait = retry_wait(exc, attempt)
                            print(f"Rate limited; retrying in {wait:.1f}s ({attempt}/3).", flush=True)
                            time.sleep(wait)
                            continue
                        break
                    except Exception as exc:
                        status, error = 0, str(exc)
                        break
                if status != 200:
                    enhanced = ""
                score = score_case(generation_case, enhanced, status_code=status)
                record = {
                    "case_id": case["id"], "user_id": case["user_id"],
                    "slice": case["slice"], "arm": arm, "memory_ids": ids,
                    "oracle_memory_ids": oracle_ids(case),
                    "retrieved_local_ids": retrieved[case["id"]],
                    "input": case["query"], "output": enhanced,
                    "status_code": status, "model": model,
                    "policy_hash": prompt_hash,
                    "request_hash": request_hash(
                        generation_case, constants, args.max_completion_tokens,
                    ),
                    "max_completion_tokens": args.max_completion_tokens,
                    "latency": round(time.monotonic() - started, 3),
                    "usage": usage, "error": error.replace(key, "[REDACTED]"),
                    "deterministic_pass": score.passed,
                    "failures": score.failures, "warnings": score.warnings,
                    "output_words": len(re.findall(r"\b[\w₹$%.-]+\b", enhanced)),
                    "human_review": {
                        "intent_fidelity_0_to_4": None,
                        "memory_use_0_to_4": None,
                        "unsupported_additions_0_to_4": None,
                        "language_fidelity_0_to_4": None,
                        "downstream_utility_0_to_4": None,
                        "notes": "",
                    },
                }
                records.append(record)
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                handle.flush()
                print(f"[{sequence:02}/{total:02}] {case['id']} {arm} HTTP {status}", flush=True)
                if status in {401, 403}:
                    print("Provider authentication/access failed; stopping without further calls.", file=sys.stderr)
                    return 1
                if sequence < total and args.delay:
                    time.sleep(args.delay)
    print(json.dumps({
        "cases": len(cases), "arms": list(ARMS), "records": len(records),
        "provider_errors": sum(item["status_code"] != 200 for item in records),
        "semantic_review_pending": len(records),
    }, indent=2))
    print(f"Results: {output}")
    return 1 if any(item["status_code"] != 200 for item in records) else 0


if __name__ == "__main__":
    raise SystemExit(main())
