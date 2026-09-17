"""Deterministic checks for Prompt Memory prompt-rewrite evaluations.

These checks deliberately cover only properties a program can establish
without pretending to understand intent. Human or blinded LLM review should
score the semantic rubric documented in evals/README.md.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field


_RESPONSE_PREAMBLES = (
    "here's the refined prompt",
    "here is the refined prompt",
    "here's an improved prompt",
    "here is an improved prompt",
    "as an ai",
    "i'd suggest",
    "i recommend",
    "you're currently",
    "you are seeking",
    "to clarify",
)

# A conservative signal for romanised Hindi. Absence is a review warning,
# not proof of failure: some short Hinglish prompts can naturally be mostly
# English technical terms.
_HINGLISH_MARKERS = frozenset({
    "mujhe", "mera", "meri", "mere", "kaise", "kya", "kyun", "chahiye",
    "hai", "hain", "karna", "karo", "batao", "samjhao", "liye", "aur",
    "nahi", "bahut", "thoda", "ek", "banao", "sakta",
})


@dataclass
class CaseScore:
    case_id: str
    passed: bool
    failures: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _contains(text: str, needle: str) -> bool:
    # Token boundaries avoid accidental matches such as required "rate"
    # passing because the output contains "create", or forbidden "recommend"
    # firing on the user's allowed phrase "no recommendation".
    return bool(re.search(
        rf"(?<!\w){re.escape(needle)}(?!\w)",
        text,
        flags=re.IGNORECASE,
    ))


def _only_explicitly_negated_mentions(text: str, needle: str) -> bool:
    """Avoid hard-failing when a forbidden phrase is explicitly prohibited.

    This is intentionally narrow. Ambiguous negations still need human review.
    """
    pattern = re.compile(rf"(?<!\w){re.escape(needle)}(?!\w)", re.IGNORECASE)
    mentions = list(pattern.finditer(text))
    if not mentions:
        return False
    negator = re.compile(
        r"\b(?:do not|don't|never|avoid|without|not|no)\s+(?:[\w-]+\s+){0,3}$",
        re.IGNORECASE,
    )
    revoked_after = re.compile(
        r"(?:\s+[\w-]+){0,3}\s+(?:is|was|has been)\s+"
        r"(?:discarded|cancelled|canceled|rejected|withdrawn|obsolete)\b",
        re.IGNORECASE,
    )
    return all(
        negator.search(text[max(0, match.start() - 60):match.start()])
        or revoked_after.match(text[match.end():match.end() + 80])
        for match in mentions
    )


def score_case(case: dict, output: str, *, status_code: int = 200) -> CaseScore:
    failures: list[str] = []
    warnings: list[str] = []
    stripped = (output or "").strip()

    if case["category"] == "degenerate_input" and not case["input"].strip():
        if status_code < 400:
            failures.append("empty input was not rejected")
        return CaseScore(case["id"], not failures, failures, warnings)

    if status_code >= 400:
        failures.append(f"endpoint returned HTTP {status_code}")
        return CaseScore(case["id"], False, failures, warnings)
    if not stripped:
        failures.append("rewriter returned an empty output")
        return CaseScore(case["id"], False, failures, warnings)

    lowered = stripped.casefold()
    for preamble in _RESPONSE_PREAMBLES:
        if lowered.startswith(preamble):
            failures.append(f"assistant-style preamble: {preamble!r}")

    for concept in case.get("required_concepts", []):
        if not _contains(stripped, concept):
            # A lexical miss is not proof of semantic loss: "under 120 words"
            # and "fewer than 120 words" mean the same thing. Route these to
            # semantic review instead of teaching the optimizer to copy the
            # dataset's wording.
            warnings.append(f"review required concept: {concept!r}")

    for literal in case.get("required_literals", []):
        if literal not in output:
            failures.append(f"missing exact literal: {literal!r}")

    for pattern in case.get("required_patterns", []):
        if not re.search(pattern, output, flags=re.IGNORECASE):
            failures.append(f"missing required pattern: {pattern!r}")

    for concept in case.get("forbidden_concepts", []):
        if _contains(stripped, concept):
            if _only_explicitly_negated_mentions(stripped, concept):
                warnings.append(f"review explicitly negated forbidden concept: {concept!r}")
            else:
                failures.append(f"introduced forbidden concept: {concept!r}")

    for exact in case.get("preserve_verbatim", []):
        if exact not in output:
            failures.append("verbatim evidence/code was changed or removed")

    words = re.findall(r"\b[\w₹$%.-]+\b", stripped, flags=re.UNICODE)
    if len(words) > case["max_words"]:
        failures.append(f"too verbose: {len(words)} words > {case['max_words']}")

    if case.get("language") == "hi-Latn":
        if re.search(r"[\u0900-\u097f]", stripped):
            failures.append("romanized Hinglish was converted to Devanagari")
        elif not _HINGLISH_MARKERS.intersection(re.findall(r"[a-z]+", lowered)):
            warnings.append("review possible switch from romanized Hinglish to English")
    if case.get("language") == "hi" and not re.search(r"[\u0900-\u097f]", stripped):
        failures.append("Hindi input did not produce Devanagari Hindi")

    if re.search(r"(^|\n)#{1,6}\s", stripped):
        failures.append("markdown heading leaked into plain-text composer output")
    if re.search(r"\*\*[^*]+\*\*|(?<!\*)\*[^*\n]+\*(?!\*)", stripped):
        failures.append("markdown emphasis leaked into plain-text composer output")

    # A prompt can legitimately end in a period (e.g. "Create ..."). This is
    # only a warning for review, not an automatic failure.
    request_markers = re.compile(
        r"\b(explain|help|create|generate|calculate|write|compare|evaluate|"
        r"analy[sz]e|review|suggest|find|research|list|draft|summari[sz]e|plan|"
        r"what|how|why|can you|please)\b",
        re.IGNORECASE,
    )
    if not request_markers.search(stripped):
        warnings.append("output may not read as a request")

    return CaseScore(case["id"], not failures, failures, warnings)


def aggregate(scores: list[CaseScore], cases_by_id: dict[str, dict]) -> dict:
    by_category: dict[str, dict[str, int]] = {}
    for score in scores:
        category = cases_by_id[score.case_id]["category"]
        bucket = by_category.setdefault(category, {"passed": 0, "failed": 0})
        bucket["passed" if score.passed else "failed"] += 1
    passed = sum(score.passed for score in scores)
    return {
        "total": len(scores),
        "passed": passed,
        "failed": len(scores) - passed,
        "pass_rate": round(passed / len(scores), 4) if scores else 0.0,
        "by_category": by_category,
    }
