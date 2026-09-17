#!/usr/bin/env python3
"""Run the curated prompt-rewrite corpus against an API deployment.

This consumes real enhancement quota. It never reads backend/.env: pass a test
JWT explicitly through PROMPT_EVAL_TOKEN and choose the deployment through
PROMPT_EVAL_API_URL.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:  # Works both as `python evals/run_prompt_eval.py` and as a package import.
    from .prompt_eval import aggregate, score_case
except ImportError:
    from prompt_eval import aggregate, score_case


HERE = Path(__file__).resolve().parent
DEFAULT_CASES = HERE / "prompt_improvement_cases.json"


def load_cases(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8"))


def request_case(
    base_url: str,
    token: str,
    case: dict,
    timeout: float,
    *,
    byok_provider: str = "",
    byok_key: str = "",
    byok_model: str = "",
) -> tuple[int, dict]:
    payload = {
        "prompt": case["input"],
        "mode": case["mode"],
        "platform": case["platform"],
        "conversation_context": case.get("conversation_context", []),
    }
    if byok_key:
        payload.update({
            "byok_provider": byok_provider or "groq",
            "byok_key": byok_key,
            "byok_model": byok_model or None,
        })
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/enhance",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {"detail": body}
        return exc.code, parsed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--category", action="append", default=[])
    parser.add_argument("--limit", type=int, help="Run at most N cases (recommended for shared quota).")
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--delay", type=float, default=2.1, help="Seconds between calls.")
    parser.add_argument("--output", type=Path, help="JSONL result path; defaults to evals/results/.")
    parser.add_argument("--dry-run", action="store_true", help="Validate selection without API calls.")
    args = parser.parse_args()

    cases = load_cases(args.cases)
    if args.category:
        wanted = set(args.category)
        cases = [case for case in cases if case["category"] in wanted]
    if args.limit is not None:
        cases = cases[: max(0, args.limit)]

    print(f"Selected {len(cases)} evaluation cases.")
    if args.dry_run:
        return 0

    token = os.getenv("PROMPT_EVAL_TOKEN", "").strip()
    base_url = os.getenv("PROMPT_EVAL_API_URL", "http://localhost:8000").strip()
    byok_provider = os.getenv("PROMPT_EVAL_BYOK_PROVIDER", "groq").strip()
    byok_key = os.getenv("PROMPT_EVAL_BYOK_KEY", "").strip()
    byok_model = os.getenv("PROMPT_EVAL_BYOK_MODEL", "").strip()
    if not token:
        print("PROMPT_EVAL_TOKEN is required for live evaluation.", file=sys.stderr)
        return 2

    output = args.output or (
        HERE / "results" / f"prompt-eval-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.jsonl"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    scores = []
    cases_by_id = {case["id"]: case for case in cases}

    with output.open("w", encoding="utf-8") as handle:
        for index, case in enumerate(cases, start=1):
            try:
                status, response = request_case(
                    base_url, token, case, args.timeout,
                    byok_provider=byok_provider,
                    byok_key=byok_key,
                    byok_model=byok_model,
                )
                enhanced = response.get("enhanced", "")
            except Exception as exc:  # Preserve the run even when one call fails.
                status, response, enhanced = 0, {"detail": str(exc)}, ""
            score = score_case(case, enhanced, status_code=status)
            scores.append(score)
            record = {
                "case_id": case["id"],
                "category": case["category"],
                "input": case["input"],
                "output": enhanced,
                "status_code": status,
                "model": response.get("model"),
                "provider": response.get("provider"),
                "latency": response.get("latency"),
                "deterministic_pass": score.passed,
                "failures": score.failures,
                "warnings": score.warnings,
                "human_scores": {
                    "intent_fidelity_0_to_4": None,
                    "constraint_preservation_0_to_4": None,
                    "useful_clarification_0_to_4": None,
                    "proportionality_0_to_4": None,
                    "downstream_utility_0_to_4": None,
                    "notes": "",
                },
            }
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            verdict = "PASS" if score.passed else "FAIL"
            print(f"[{index:02}/{len(cases):02}] {verdict} {case['id']}")
            if index < len(cases) and args.delay:
                time.sleep(args.delay)

    summary = aggregate(scores, cases_by_id)
    print(json.dumps(summary, indent=2))
    print(f"Results: {output}")
    return 1 if summary["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
