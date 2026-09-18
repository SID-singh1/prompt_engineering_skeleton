#!/usr/bin/env python3
"""Paired, direct-provider context-behavior evaluation without product writes.

The controlled arm uses hand-authored fixtures, NOT the production retriever.
This measures generation behavior conditional on supplied context, not retrieval
quality or the end-to-end application. Review semantic quality by hand.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

try:
    from .prompt_eval import score_case
    from .run_direct_prompt_eval import (
        HERE, evaluation_key, messages_for_case, production_constants,
        provider_request,
    )
    from .run_prompt_eval import load_cases
except ImportError:
    from prompt_eval import score_case
    from run_direct_prompt_eval import (
        HERE, evaluation_key, messages_for_case, production_constants,
        provider_request,
    )
    from run_prompt_eval import load_cases


DEFAULT_CASES = HERE / "context_behavior_cases.json"
CONTEXT_FIELDS = (
    "selected_context", "related_saved_prompts", "passive_context",
    "feedback_summary", "conversation_context",
)
TEMPERATURES = {"quick": 0.5, "deep": 0.6, "creative": 0.7}


def arm_case(case: dict, arm: str) -> dict:
    if arm not in {"none", "controlled"}:
        raise ValueError(f"Unknown arm: {arm}")
    result = dict(case)
    if arm == "none":
        for field in CONTEXT_FIELDS:
            result.pop(field, None)
    return result


def arm_order(index: int) -> tuple[str, str]:
    """Counterbalance arm order so every controlled call is not second."""
    return ("none", "controlled") if index % 2 == 0 else ("controlled", "none")


def validate_cases(cases: list[dict]) -> None:
    if not cases:
        raise ValueError("No context cases selected")
    ids = [case["id"] for case in cases]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate context case IDs")
    for case in cases:
        if not case.get("input", "").strip():
            raise ValueError(f"Empty input in {case['id']}")
        if not any(case.get(field) for field in CONTEXT_FIELDS):
            raise ValueError(f"No controlled context in {case['id']}")


def summarize(records: list[dict]) -> dict:
    summary = {}
    for arm in ("none", "controlled"):
        items = [record for record in records if record["arm"] == arm]
        summary[arm] = {
            "completed": len(items),
            "provider_errors": sum(record["status_code"] != 200 for record in items),
            "hard_check_passes": sum(record["deterministic_pass"] for record in items),
            "semantic_review_required": len(items),
        }
    return summary


def retry_wait(exc: httpx.HTTPStatusError, attempt: int) -> float:
    """Respect provider 429 advice, with a modest exponential floor."""
    header = exc.response.headers.get("retry-after", "")
    match = re.search(r"try again in ([\d.]+)s", exc.response.text, re.IGNORECASE)
    suggested = float(header) if re.fullmatch(r"\d+(?:\.\d+)?", header) else 0.0
    if match:
        suggested = max(suggested, float(match.group(1)))
    return min(60.0, max(suggested + 2.0, 8.0 * 2 ** (attempt - 1)))


def successful_resume_records(path: Path, cases: list[dict], model: str) -> dict[tuple[str, str], dict]:
    allowed = {(case["id"], arm) for case in cases for arm in ("none", "controlled")}
    records = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        pair = (record["case_id"], record["arm"])
        if pair not in allowed:
            raise ValueError(f"Unexpected resume case/arm: {pair}")
        if record.get("model") != model:
            raise ValueError("Resume model differs from current model")
        if record.get("status_code") == 200:
            records[pair] = record
    return records


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--case-id", action="append", default=[], help="Evaluate only these exact case IDs (repeatable)")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--delay", type=float, default=12.0)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--resume-from", type=Path, help="Reuse successful pairs from an earlier JSONL; write a new output file")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive")
    if args.delay < 0 or args.timeout <= 0:
        parser.error("--delay must be nonnegative and --timeout positive")
    cases = load_cases(args.cases)
    if args.case_id:
        wanted = set(args.case_id)
        known = {case["id"] for case in cases}
        if wanted - known:
            parser.error(f"Unknown case IDs: {sorted(wanted - known)}")
        cases = [case for case in cases if case["id"] in wanted]
    if args.limit is not None:
        cases = cases[:args.limit]
    validate_cases(cases)
    constants = production_constants()
    for case in cases:
        for arm in ("none", "controlled"):
            messages_for_case(arm_case(case, arm), constants)
    print(f"Validated {len(cases)} cases, {2 * len(cases)} paired calls (none vs controlled).")
    print("Controlled context is hand-authored; this does not test actual retrieval.")
    if args.dry_run:
        return 0

    key = evaluation_key()
    if not key:
        print("PROMPT_EVAL_BYOK_KEY is required (process environment or ignored backend/.env).", file=sys.stderr)
        return 2
    base_url = os.getenv("PROMPT_EVAL_PROVIDER_URL", "https://api.groq.com/openai/v1").strip()
    model = os.getenv("PROMPT_EVAL_BYOK_MODEL", "qwen/qwen3.8-27b").strip()
    output = args.output or (
        HERE / "results" / f"context-generation-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.jsonl"
    )
    if args.resume_from and output.resolve() == args.resume_from.resolve():
        parser.error("--output must differ from --resume-from")
    reused = successful_resume_records(args.resume_from, cases, model) if args.resume_from else {}
    if reused:
        print(f"Reusing {len(reused)} successful pairs; retrying {2 * len(cases) - len(reused)}.")
    output.parent.mkdir(parents=True, exist_ok=True)
    records = []
    total = 2 * len(cases)
    with output.open("w", encoding="utf-8") as handle:
        for index, case in enumerate(cases):
            for arm_index, arm in enumerate(arm_order(index)):
                sequence = 2 * index + arm_index + 1
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
                            messages=messages_for_case(arm_case(case, arm), constants),
                            temperature=TEMPERATURES.get(case.get("mode"), 0.6),
                            timeout=args.timeout,
                        )
                        status, error = 200, ""
                        break
                    except httpx.HTTPStatusError as exc:
                        status = exc.response.status_code
                        error = exc.response.text[:500]
                        if status == 429 and attempt < 4:
                            wait = retry_wait(exc, attempt)
                            print(f"Rate limited; retrying in {wait:.1f}s ({attempt}/3).", flush=True)
                            time.sleep(wait)
                            continue
                        break
                    except Exception as exc:
                        status, error = 0, str(exc)
                        break
                # A provider failure is not a model-quality result.
                if status != 200:
                    enhanced = ""
                score = score_case(case, enhanced, status_code=status)
                record = {
                    "case_id": case["id"], "persona_id": case.get("persona_id"),
                    "arm": arm, "context_source": "none" if arm == "none" else "controlled_fixture",
                    "input": case["input"], "output": enhanced,
                    "status_code": status, "model": model,
                    "latency": round(time.monotonic() - started, 3),
                    "usage": usage, "error": error.replace(key, "[REDACTED]"),
                    "deterministic_pass": score.passed,
                    "failures": score.failures, "warnings": score.warnings,
                    "intent": case.get("intent", ""),
                    "human_scores": {
                        "intent_fidelity_0_to_4": None,
                        "constraint_preservation_0_to_4": None,
                        "context_use_0_to_4": None,
                        "irrelevant_context_ignored_0_to_4": None,
                        "language_fidelity_0_to_4": None,
                        "notes": "",
                    },
                }
                records.append(record)
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                handle.flush()
                print(f"[{sequence:02}/{total:02}] {case['id']} {arm} HTTP {status}", flush=True)
                if sequence < total and args.delay:
                    time.sleep(args.delay)
    print(json.dumps(summarize(records), indent=2))
    print("Interpret required-concept misses in the no-context arm as expected; review each pair semantically.")
    print(f"Results: {output}")
    return 1 if any(record["status_code"] != 200 for record in records) else 0


if __name__ == "__main__":
    raise SystemExit(main())
