#!/usr/bin/env python3
"""Benchmark the production rewrite prompt directly against an LLM provider.

Unlike run_prompt_eval.py, this bypasses the Prompt Memory API so synthetic
cases do not consume product quota or enter Mongo/Qdrant/dashboard analytics.
It extracts the literal production prompt constants from services/prompt_builder.py,
making prompt drift visible while avoiding imports of database/embedding code.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import sys
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

import httpx

try:
    from .prompt_eval import aggregate, score_case
    from .run_prompt_eval import DEFAULT_CASES, load_cases
except ImportError:
    from prompt_eval import aggregate, score_case
    from run_prompt_eval import DEFAULT_CASES, load_cases


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PROMPTS_PY = ROOT / "backend" / "services" / "prompt_builder.py"
CONSTANTS = {
    "SYSTEM_PROMPT_BASE", "MODE_INSTRUCTIONS", "PLATFORM_HINTS",
    "LANGUAGE_NAMES", "OUTPUT_INSTRUCTION", "STEERING_TURN",
}


def evaluation_key() -> str:
    """Read only the dedicated eval key; never fall back to the product key."""
    key = os.getenv("PROMPT_EVAL_BYOK_KEY", "").strip()
    if key:
        return key
    try:
        from dotenv import dotenv_values
    except ImportError:
        return ""
    return (dotenv_values(ROOT / "backend" / ".env").get("PROMPT_EVAL_BYOK_KEY") or "").strip()


def production_constants(path: Path = PROMPTS_PY) -> dict:
    """Extract literal prompt constants without importing production services."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    found = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in CONSTANTS:
                    found[target.id] = ast.literal_eval(node.value)
    missing = CONSTANTS - found.keys()
    if missing:
        raise RuntimeError(f"Production prompt constants not found: {sorted(missing)}")
    return found


def _conversation_context(messages: list[str]) -> str:
    if not messages:
        return ""
    user_messages = [item for item in messages if item.startswith("[user]")]
    other_messages = [item for item in messages if not item.startswith("[user]")]
    if user_messages:
        selected = [item[:300] for item in user_messages[-3:]]
        if other_messages:
            selected.append(other_messages[-1][:500])
    else:
        selected = [item[:300] for item in messages[-4:]]
    return "\n".join(f"- {item}" for item in selected)


def messages_for_case(case: dict, constants: dict) -> list[dict]:
    mode = case.get("mode", "deep")
    if mode not in constants["MODE_INSTRUCTIONS"]:
        mode = "deep"
    platform = case.get("platform", "unknown")

    system_parts = [
        constants["SYSTEM_PROMPT_BASE"],
        constants["MODE_INSTRUCTIONS"][mode],
    ]
    if platform in constants["PLATFORM_HINTS"]:
        system_parts.append(f"### PLATFORM\n{constants['PLATFORM_HINTS'][platform]}")
    system_parts.append(constants["OUTPUT_INSTRUCTION"])

    user_parts = []
    if case.get("feedback_summary"):
        user_parts.append("### THIS USER'S FEEDBACK PATTERNS\n" + case["feedback_summary"])
    context = _conversation_context(case.get("conversation_context", []))
    if context:
        user_parts.append(
            "### RECENT CONVERSATION (what the user has been discussing)\n" + context
        )
    selected = case.get("selected_context", [])
    if selected:
        user_parts.append(
            "### USER-SELECTED CONTEXT\n" + "\n".join(
                f'[Selected by user] {item.get("title", "Saved Prompt")}: "{item["content"]}"'
                for item in selected
            )
        )
    related = case.get("related_saved_prompts", [])
    if related:
        user_parts.append(
            "### RELATED SAVED PROMPTS (use only if relevant)\n" + "\n".join(
                f'[Auto-matched] {item.get("title", "Saved Prompt")}: "{item["content"]}"'
                for item in related
            )
        )
    passive = case.get("passive_context", [])
    if passive:
        user_parts.append(
            "### PAST PROMPT PATTERNS (user's prompting style — reference only, do NOT copy their language)\n"
            + "\n".join(
                f'[Past pattern] User asked: "{item["original"]}" → Was refined to: "{item["refined"]}"'
                for item in passive if item["original"] != item["refined"]
            )
        )
    user_parts.append(f'### USER\'S PROMPT\n"{case["input"]}"')

    source_language = case.get("language", "en")
    language_name = constants["LANGUAGE_NAMES"].get(source_language, source_language)
    same_language = f"The input text is in {language_name} — do NOT switch languages."
    # Production names a language only on positive evidence; text its detector
    # reads as plain Latin-script "en" is asked for in its own language.
    if source_language == "en":
        language_name = "the same language as the USER'S PROMPT"
        same_language = "Do NOT translate it or switch languages."
    task = (
        "### TASK\n"
        "REWRITE the user's raw text above into a better PROMPT — a question or request they will paste into an AI chat. "
        "Do NOT answer, respond to, summarize, or evaluate the user's message. "
        "Do NOT start with 'You are...' or 'You're currently...' — start with an imperative verb, 'I need...', or a direct question. "
        "Use conversation context to resolve ambiguity. "
        "CRITICALLY: If any provided context is completely irrelevant to the User's Prompt, IGNORE IT COMPLETELY. Do not try to blend unrelated topics.\n\n"
        f"⚠️ LANGUAGE REQUIREMENT: Your output MUST be in **{language_name}**. "
        f"{same_language} "
        "Ignore the language of past patterns, saved prompts, or conversation history — "
        f"output ONLY in **{language_name}**."
    )
    if source_language == "hi-Latn":
        task += (
            "\n⚠️ SCRIPT REQUIREMENT: The user typed Hindi using the English alphabet. "
            "Reply the same way — romanised Hindi in Latin characters, mixing in English "
            "words wherever that is natural, exactly as the user did. "
            "Do NOT transliterate into Devanagari (देवनागरी) and do NOT translate into "
            "pure English."
        )
    user_parts.append(task)

    return [
        {"role": "system", "content": "\n".join(system_parts)},
        {"role": "assistant", "content": constants["STEERING_TURN"]},
        {"role": "user", "content": "\n\n".join(user_parts)},
    ]


def stratified(cases: list[dict], limit: int | None) -> list[dict]:
    if limit is None or limit >= len(cases):
        return cases
    buckets: dict[str, deque] = defaultdict(deque)
    for case in cases:
        buckets[case["category"]].append(case)
    selected = []
    categories = sorted(buckets)
    while len(selected) < limit and any(buckets.values()):
        for category in categories:
            if buckets[category] and len(selected) < limit:
                selected.append(buckets[category].popleft())
    return selected


def provider_request(
    *, base_url: str, api_key: str, model: str, messages: list[dict],
    temperature: float, timeout: float, max_completion_tokens: int = 1200,
) -> tuple[str, dict]:
    params = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_completion_tokens": max_completion_tokens,
    }
    if model.startswith("qwen/qwen3"):
        params.update({"reasoning_effort": "none", "reasoning_format": "hidden"})
    elif model.startswith("openai/gpt-oss"):
        params["reasoning_effort"] = "low"

    response = httpx.post(
        f"{base_url.rstrip('/')}/chat/completions",
        json=params,
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=timeout,
    )
    response.raise_for_status()
    body = response.json()
    return body["choices"][0]["message"]["content"], body.get("usage", {})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--category", action="append", default=[])
    parser.add_argument("--limit", type=int)
    parser.add_argument("--stratified", action="store_true")
    parser.add_argument("--delay", type=float, default=12.0)
    parser.add_argument("--timeout", type=float, default=45.0)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    cases = load_cases(args.cases)
    if args.category:
        wanted = set(args.category)
        cases = [case for case in cases if case["category"] in wanted]
    if args.stratified:
        cases = stratified(cases, args.limit)
    elif args.limit is not None:
        cases = cases[: max(0, args.limit)]
    constants = production_constants()
    print(f"Selected {len(cases)} direct-model evaluation cases.")
    if args.dry_run:
        return 0

    api_key = evaluation_key()
    base_url = os.getenv("PROMPT_EVAL_PROVIDER_URL", "https://api.groq.com/openai/v1").strip()
    model = os.getenv("PROMPT_EVAL_BYOK_MODEL", "qwen/qwen3.8-27b").strip()
    if not api_key:
        print("PROMPT_EVAL_BYOK_KEY is required.", file=sys.stderr)
        return 2

    output = args.output or (
        HERE / "results" / f"direct-eval-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.jsonl"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    temperatures = {"quick": 0.5, "deep": 0.6, "creative": 0.7}
    scores = []
    cases_by_id = {case["id"]: case for case in cases}

    with output.open("w", encoding="utf-8") as handle:
        for index, case in enumerate(cases, start=1):
            started = time.monotonic()
            status, enhanced, usage, error = 200, "", {}, ""
            try:
                enhanced, usage = provider_request(
                    base_url=base_url, api_key=api_key, model=model,
                    messages=messages_for_case(case, constants),
                    temperature=temperatures.get(case["mode"], 0.6), timeout=args.timeout,
                )
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                error = exc.response.text[:500]
            except Exception as exc:
                status, error = 0, str(exc)

            score = score_case(case, enhanced, status_code=status)
            scores.append(score)
            record = {
                "case_id": case["id"], "category": case["category"],
                "mode": case["mode"], "platform": case["platform"],
                "input": case["input"], "output": enhanced,
                "status_code": status, "model": model,
                "latency": round(time.monotonic() - started, 3),
                "usage": usage, "error": error.replace(api_key, "[REDACTED]"),
                "deterministic_pass": score.passed,
                "failures": score.failures, "warnings": score.warnings,
            }
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            print(f"[{index:02}/{len(cases):02}] {'PASS' if score.passed else 'FAIL'} {case['id']}", flush=True)
            if index < len(cases) and args.delay:
                time.sleep(args.delay)

    summary = aggregate(scores, cases_by_id)
    print(json.dumps(summary, indent=2))
    print(f"Results: {output}")
    return 1 if summary["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
