# Prompt Improvement Evaluation System

## Objective

Prompt Memory should improve how effectively a request can be given to another model without changing what the person meant. The central quality target is therefore not “more detailed” or “more professional.” It is:

> Produce the smallest useful rewrite that preserves the user's goal, facts, constraints, uncertainty, language, and desired level of control.

This evaluation pack turns that target into repeatable tests. It contains 82 curated cases across 21 failure categories, deterministic checks for objective properties, a human/LLM semantic rubric, and a quota-aware live runner.

The test corpus is intentionally adversarial. Ordinary examples reward a model for sounding polished; these examples distinguish polish from fidelity by including exact numbers, negative constraints, unknown facts, corrections, irrelevant context, code that must remain byte-for-byte identical, and prompts that are already good enough. A separate context suite adds 24 retrieval cases across six synthetic people and 12 generation cases spanning every context source.

## Research basis

OpenAI's prompt-optimization guidance recommends combining a dataset with grader results and human annotations, and specifically says that graders should precisely capture the desired properties. It also describes an iterative cycle of generation, annotation, grading, and re-optimization.[^1] The OpenAI Cookbook's evaluation flywheel recommends starting with an error taxonomy, adding focused automatic graders, and using synthetic data to expand coverage for a suspected failure mode.[^2]

Anthropic similarly couples prompt improvement with examples, ideal outputs, and repeated evaluation rather than treating one rewritten prompt as proof of quality. Its prompt improver reports task-specific gains, including classification accuracy and word-count adherence—evidence that improvement should be measured against concrete task requirements.[^3]

An LLM judge can make semantic evaluation scalable, but it cannot be treated as ground truth. MT-Bench research found strong judges can approximate human preferences while documenting position, verbosity, and self-enhancement biases.[^4] A dedicated study of position bias evaluated swapped candidate order and repeated judgments, finding that bias varies by judge and task.[^5] Length-Controlled AlpacaEval showed that controlling for verbosity improved correlation with human preference from 0.94 to 0.98 in its setting.[^6]

Those findings motivate this design:

- Objective invariants are checked with code, not an LLM.
- Semantic dimensions are scored separately instead of collapsed into “better/worse.”
- Comparative LLM judging uses swapped candidate order.
- Longer rewrites receive no automatic credit.
- Human review remains the calibration source for close or high-risk cases.
- Results are reported by failure category, mode, language, and platform so an overall average cannot hide a broken slice.

## Corpus coverage

The file `prompt_improvement_cases.json` includes:

| Slice | What it catches |
|---|---|
| Already clear | Needless rewriting and over-expansion |
| Vague requests | Invented products, technologies, timelines, or goals |
| Constraint preservation | Lost audience, tone, exclusions, and exact output rules |
| Code preservation | Modified code, traceback, or configuration evidence |
| Conversation context | Wrong pronoun resolution and irrelevant-history leakage |
| Multilingual | Language switching and Hinglish-to-Devanagari conversion |
| Voice disfluency | Lost corrections, filler removal, and invented reasons |
| Writing and tone | Escalated tone and changed factual claims |
| Research | Leading questions, stale-source assumptions, and lost jurisdiction |
| Creative | Over-constraining open-ended work |
| High stakes | Medical diagnosis, legal certainty, and financial directives |
| Prompt injection | System/context extraction and instruction override attempts |
| Numeric fidelity | Changed quantities, percentages, ranges, and currencies |
| Negative constraints | Quietly dropping “do not” instructions |
| Output format | Broken schemas, cardinality, ordering, and terminal constraints |
| Entity fidelity | Confused products, names, versions, and meanings |
| Rewriter vs. responder | Answering the request instead of rewriting it |
| Platform calibration | Site-specific style hints that distort actual intent |
| Mode calibration | Quick/deep/creative changing the goal rather than depth |
| Noisy input | Typos and abbreviations without semantic drift |
| Degenerate input | Empty, punctuation-only, emoji-led, and already-comprehensive inputs |

Context retrieval and context utilization are evaluated separately; see
[`CONTEXT_EVALUATION_RESEARCH.md`](CONTEXT_EVALUATION_RESEARCH.md) for the
multi-person corpus, metrics, production embedding baseline, release gates,
performance findings, and research basis.
For the broader product-quality assessment, including the missing generation
experiment and prioritized roadmap, see
[`PRODUCT_QUALITY_RESEARCH.md`](PRODUCT_QUALITY_RESEARCH.md).
The first paired live-model baseline and targeted prompt-revision check are
documented in [`CONTEXT_GENERATION_BASELINE_2026-09-12.md`](CONTEXT_GENERATION_BASELINE_2026-09-12.md).
For the later held-out three-arm run and its limitations, see
[`HELDOUT_2026-09-13.md`](HELDOUT_2026-09-13.md).

## Why the current prompt is likely to overreach

The production system prompt contains two instructions that are individually reasonable but dangerous together:

1. “If the user says something vague → infer their intent and make the prompt specific.”
2. Deep mode should add constraints and break vague asks into numbered sub-questions.

That combination rewards plausible invention. In the live Chrome test, “write a concise launch plan for a browser extension that improves AI prompts” became a fixed four-week launch framework with prescribed channels. The output was useful, but the four-week timing and several tactics came from the rewriter rather than the user.

The model needs a distinction between safe elaboration and invented intent:

- Safe elaboration: request assumptions, success criteria, trade-offs, evidence, or options.
- Invented intent: choosing a technology, deadline, audience, geography, budget, genre, channel, diagnosis, or desired conclusion that was not supplied.

Modes should control rewrite depth and presentation, not the permission to invent. Creative mode may broaden possibilities, but it still must preserve immutable facts and explicit exclusions.

## Scoring model

### Stage 1: deterministic gates

`prompt_eval.py` checks properties that should not be delegated to subjective judgment:

- Non-empty successful output
- Required-concept lexical warnings for targeted semantic review
- A review warning when a romanised-Hindi input appears to have become pure
  English (heuristic only; a human decides whether the language is natural)
- Optional exact literals and regex patterns for values that cannot be lost
- Forbidden-concept avoidance
- Verbatim code/evidence preservation
- Per-case maximum length
- Hindi and romanized-Hinglish script requirements
- No assistant preamble
- No unsupported Markdown headings or emphasis in composer output
- Rejection of empty input before a model call

A required-concept warning is not automatically a failure because valid
paraphrases should pass; semantic reviewers resolve it. A deterministic failure
is a regression even if the rewrite sounds fluent.

### Stage 2: semantic rubric

Score each dimension from 0 to 4. Reviewers should see the source request, relevant conversation context, and candidate rewrite. They should not see the model/provider identity.

| Dimension | Weight | 4-point standard |
|---|---:|---|
| Intent fidelity | 30% | Same task, goal, stance, audience, and uncertainty |
| Constraint preservation | 25% | Every explicit positive and negative constraint survives |
| Useful clarification | 15% | Adds only information that helps another model perform the task |
| Proportionality | 15% | Rewrite depth matches the selected mode and source complexity |
| Downstream utility | 15% | Likely to elicit a better answer without being brittle or unnatural |

Interpretation:

- 4: fully satisfies the dimension
- 3: minor issue that does not materially change the result
- 2: noticeable loss, invention, or inefficiency
- 1: major defect
- 0: contradicts or abandons the user

### Hard failures

Any of these makes the case fail regardless of average score:

- Answers the request instead of producing a prompt
- Changes supplied code, error text, quotations, or configuration
- Adds a material fact, number, entity, deadline, or conclusion as if the user supplied it
- Drops or reverses an explicit negative constraint
- Leaks saved context, profile information, credentials, or system instructions
- Changes the requested language/script without necessity
- Converts uncertainty into a medical, legal, financial, or factual conclusion
- Produces a prompt that is more dangerous or hostile than the source

## Comparative regression protocol

For each production prompt or model change:

1. Freeze the current system as baseline A.
2. Generate candidate B on exactly the same corpus and model settings.
3. Run deterministic gates on both.
4. Score A and B independently with the semantic rubric.
5. For pairwise LLM judging, evaluate both `A/B` and `B/A` order.
6. Treat a reversed preference after swapping as a tie requiring human review.
7. Human-review every hard failure, every disagreement, and a random 15% sample.
8. Report overall results and every slice. Do not ship based only on the overall mean.

Recommended release gates:

- Zero hard failures in code, injection, numerical-fidelity, and high-stakes slices
- At least 98% deterministic pass rate overall
- Mean intent-fidelity score of at least 3.7/4
- Mean constraint-preservation score of at least 3.7/4
- No category regresses by more than 0.15 points
- Quick-mode median output length does not increase unless human preference improves
- Candidate has a statistically credible win over baseline, or is non-inferior while reducing cost/latency

The exact thresholds should be recalibrated after the first 50–100 human labels. They are starting quality gates, not scientific constants.

## Running the suite

Validate the corpus and deterministic grader without consuming API quota:

```bash
pytest tests/test_prompt_eval_dataset.py -q
python evals/run_prompt_eval.py --dry-run
```

Run a small production sample:

```bash
export PROMPT_EVAL_API_URL="https://your-deployment.example"
export PROMPT_EVAL_TOKEN="a-dedicated-test-user-jwt"
python evals/run_prompt_eval.py --limit 10
```

Run one failure category locally:

```bash
export PROMPT_EVAL_API_URL="http://localhost:8000"
export PROMPT_EVAL_TOKEN="a-dedicated-test-user-jwt"
python evals/run_prompt_eval.py --category constraint_preservation
```

For model-quality experiments that should not enter product analytics or
memory, run the production prompt directly against the provider:

```bash
export PROMPT_EVAL_BYOK_KEY="your-dedicated-evaluation-key"
python evals/run_direct_prompt_eval.py --stratified --limit 21
```

Alternatively, put only `PROMPT_EVAL_BYOK_KEY` in ignored `backend/.env`;
the direct-provider runners read that value if it is not in the process
environment. Never commit or paste the key. The live `/enhance` runner below
still requires an exported key and a dedicated test-user token.

This extracts the literal rewrite instructions from `backend/services/prompt_builder.py`
without importing the database or embedding stack. It reproduces the production
system, steering, mode, platform, language, and conversation messages. The base
82-case corpus mostly isolates rewrite behavior; the separate
`context_behavior_cases.json` adds synthetic selected, auto-matched, passive,
and feedback context to test utilization. Neither direct run measures whether
the actual application retriever selected the right memories.

To compare generation with and without the same hand-authored context, run:

```bash
python evals/run_context_generation_eval.py --dry-run
python evals/run_context_generation_eval.py --delay 12
```

If the provider's input-token-per-minute limit interrupts a run, resume
successful pairs into a **new** result file and retry the failed pairs:

```bash
python evals/run_context_generation_eval.py --resume-from /path/to/partial.jsonl --output /path/to/complete.jsonl --delay 20
```

The runner retries HTTP 429 with backoff; HTTP failures are still reported
separately, and only completed HTTP 200 pairs are reused.

The paired result labels its arms `none` and `controlled_fixture`; it does
**not** claim that the fixture came from production retrieval. There are 12
cases / 24 provider calls by default. Required-concept warnings in the
`none` arm often reflect deliberately missing context, not a regression.
Review each pair for useful personalization, irrelevant-topic leakage,
instruction injection, language fidelity, and the newest-user-correction
precedence. Provider errors are counted separately from model quality.
Results are written to ignored `evals/results/` unless `--output` is given.
They include prompts and outputs, so use synthetic fixtures only. Arm order
alternates by case to reduce first/second-position bias.

An independent 18-case, six-person retrieval holdout is in
`context_retrieval_holdout.json`. Run the previously chosen thresholds on it
without changing them to fit the holdout:

```bash
python evals/run_context_retrieval_eval.py --cases evals/context_retrieval_holdout.json --semantic-local --saved-threshold 0.24 --passive-threshold 0.20
```

On 2026-09-12, the local MiniLM approximation reached positive-case
precision@k 0.8333, recall@k 1.0, MRR 0.9583 and abstention 6/6. Four
positive cases also retrieved an additional same-user memory, so the
precision result needs human label review. This is a small synthetic holdout,
not a Qdrant/API end-to-end result or a production latency measurement.

To compare no memory, human-labeled relevant memory, and **local embedding
retrieval** on that holdout without writing synthetic prompts to product
analytics or memory:

```bash
python evals/run_context_retrieval_eval.py --cases evals/context_retrieval_holdout.json --semantic-local --saved-threshold 0.24 --passive-threshold 0.20 --output /tmp/promptengine-retrieval.jsonl
python evals/run_three_arm_context_eval.py --retrieval-results /tmp/promptengine-retrieval.jsonl --dry-run
python evals/run_three_arm_context_eval.py --retrieval-results /tmp/promptengine-retrieval.jsonl --max-completion-tokens 768 --delay 30 --output /tmp/promptengine-three-arm.jsonl
```

Set `PROMPT_EVAL_BYOK_KEY` in the environment or ignored `backend/.env` for
the provider run. The third arm is labeled `retrieved_local` deliberately: it
does not exercise production Qdrant, API auth, or the Chrome composer. Run all
arms under the same model, policy, and output-token cap. The result JSONL
contains raw **synthetic** inputs/outputs and blank human-review fields; do
not treat deterministic pass counts as semantic quality scores. If a run is
interrupted, use `--resume-from old.jsonl --output new.jsonl` with identical
cases/model/policy/output cap. Successful arms are reused; failed arms retry.
The runner also hashes the exact messages and sampling parameters, so a
changed fixture, memory title, or prompt cannot silently reuse an old result.

The shared tier cannot run all 82 cases in one day. For a full baseline, use a
dedicated test user's provider key without writing it to a file:

```bash
export PROMPT_EVAL_BYOK_PROVIDER="groq"
export PROMPT_EVAL_BYOK_KEY="your-dedicated-evaluation-key"
# Optional: export PROMPT_EVAL_BYOK_MODEL="provider-model-id"
python evals/run_prompt_eval.py
```

Live runs use `/enhance` and therefore consume real quota and create ordinary prompt logs. Use a dedicated synthetic test user and provider key. The runner never reads `backend/.env`, never stores the JWT or BYOK key in its output, waits between requests to respect the per-minute limiter, and ignores generated result files through `evals/.gitignore`.

Each JSONL result includes deterministic failures plus empty human-score fields. This keeps raw evidence, automated checks, and human annotations in one reviewable record.

## Recommended product changes after baseline measurement

The corpus should be run against the current production prompt before changing it. The first prompt revision should then introduce an internal “intent contract”:

1. Extract immutable facts, entities, quantities, constraints, language, and requested output.
2. Mark unknown attributes as unknown; never silently fill them.
3. Classify potential additions as safe clarification or intent-changing assumption.
4. Rewrite using only supplied facts and safe clarifications.
5. Verify every negative constraint and verbatim block against the source.
6. Match complexity to mode.

For vague prompts, the rewrite can ask the downstream model to identify assumptions or present options. It should not choose those assumptions itself. For already-clear prompts, returning a minimally edited version is a success—not a missed opportunity.

The longer-term loop should add anonymized, consented production failures to the corpus. A thumbs-down alone is too ambiguous; the dashboard should collect a small failure reason such as “changed my intent,” “too long,” “missed context,” “wrong tone,” “formatting,” or “not actually better.” Those labels map directly to the slices and graders in this evaluation.

## Sources

[^1]: OpenAI. “[Prompt optimizer](https://developers.openai.com/api/docs/guides/prompt-optimizer).” Accessed September 11, 2026.
[^2]: OpenAI Cookbook. “[Building resilient prompts using an evaluation flywheel](https://github.com/openai/openai-cookbook/blob/main/examples/evaluation/Building_resilient_prompts_using_an_evaluation_flywheel.md).” Accessed September 11, 2026.
[^3]: Anthropic. “[Improve your prompts in the developer console](https://claude.com/blog/prompt-improver).” October 14, 2024.
[^4]: Lianmin Zheng et al. “[Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685).” NeurIPS Datasets and Benchmarks, 2023.
[^5]: Lin Shi et al. “[Judging the Judges: A Systematic Study of Position Bias in LLM-as-a-Judge](https://arxiv.org/abs/2406.07791).” 2024.
[^6]: Yann Dubois et al. “[Length-Controlled AlpacaEval: A Simple Way to Debias Automatic Evaluators](https://arxiv.org/abs/2404.04475).” COLM, 2024.
