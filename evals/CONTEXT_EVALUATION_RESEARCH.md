# Context Retrieval and Personalization Evaluation

## Executive finding

Prompt Memory needs two separately scored systems:

1. Retrieval: did the application find the right memories for the right person?
2. Utilization: after receiving those memories, did the rewrite model use relevant context, ignore distractors, preserve corrections, and resist injected instructions?

Scoring only the final rewrite cannot identify which system failed. A good rewrite can hide a broken retriever by succeeding without memory; a correct retrieval can still produce a bad rewrite when the model copies irrelevant or malicious context.

The first production-model retrieval run used 24 synthetic queries, 18 memories, and six people. With the former thresholds—0.40 for saved prompts and 0.50 for passive patterns—the multilingual MiniLM retriever achieved 0.444 precision@3, 0.333 recall@3, 0.444 mean reciprocal rank, and 0.370 normalized discounted cumulative gain **on the 18 positive cases**. Cross-user leakage was zero and all six no-context cases abstained correctly, but many genuinely useful memories never cleared the thresholds. Earlier headline figures of 0.583/0.500/0.583 included those six correct abstentions as perfect positive retrieval scores; the evaluator has since been corrected to report abstention separately.

A threshold candidate of 0.24 for saved prompts and 0.20 for passive patterns achieved 0.843 precision@3, 0.917 recall@3, 0.917 mean reciprocal rank, and 0.897 normalized discounted cumulative gain on the 18 positive cases. Abstention remained 1.000 and no cross-user result appeared. Warm local latency was approximately 9 ms at p50 and 21 ms at p95 after model loading. These numbers justify a candidate configuration, not a universal optimum: the corpus is small and was used for calibration, so future production labels require a held-out recalibration.

## Research basis

RAGAS separates retrieval quality, faithful use of retrieved passages, and generation quality. That separation directly supports independent retrieval and rewrite-model scorecards rather than one blended “prompt improved” score.[^1]

LongMemEval evaluates information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention. It reports a substantial accuracy drop over sustained histories and frames memory as three stages: indexing, retrieval, and reading. Its findings also motivate correction, time, and no-answer cases rather than only same-topic similarity examples.[^2]

LaMP evaluates personalization across multiple entries per user profile and compares term, semantic, and time-aware retrieval. Its multi-user design supports evaluating diverse synthetic people and keeping personalization quality separate from a single default persona.[^3]

AgentDojo treats externally supplied content as untrusted and evaluates prompt injection over realistic tasks. Although Prompt Memory is not an autonomous tool-using agent, saved prompts, passive history, and scraped conversation content create the same instruction/data boundary: retrieved text must never override the current request or disclose context.[^4]

Qdrant documents payload filtering as the mechanism for imposing business constraints that embeddings cannot represent. The production implementation uses an exact `user_id` payload filter for both saved and passive collections; tests treat any cross-user result as a release-blocking confidentiality failure.[^5]

## Evaluation architecture

### Retrieval corpus

`context_retrieval_cases.json` contains:

- Six synthetic people with deliberately overlapping topics
- Eighteen saved or passive memories
- Twenty-four queries
- Graded relevance labels
- Six explicit abstention cases
- Multi-memory, constraint, entity, jurisdiction, language, high-stakes, voice, and cross-topic slices

All memories are available to the evaluator, but only memories owned by the case's person may be returned. This catches a filter regression even when another person's memory is semantically perfect for the query.

### Retrieval metrics

| Metric | Purpose | Gate |
|---|---|---:|
| Precision@k | How much injected context is useful, on positive cases only | ≥ 0.80 |
| Recall@k | How much useful context is found, on positive cases only | ≥ 0.85 |
| Mean reciprocal rank | Whether the first useful memory is early, on positive cases only | ≥ 0.85 |
| nDCG@k | Whether highly relevant memories outrank marginal ones | Reported |
| Abstention accuracy | Whether unrelated prompts receive no memory | ≥ 0.90 |
| Cross-user leaks | Tenant isolation | Exactly 0 |
| Duplicate results | Context/token waste | Exactly 0 |
| Warm retrieval p95 | Tail latency after model load | ≤ 250 ms |

Overall scores cannot hide critical failures. Entity resolution, constraints, jurisdiction, language, voice, and high-stakes slices have minimum recall gates of their own.

### Context-utilization corpus

`context_behavior_cases.json` adds twelve rewrite cases representing:

- Relevant and irrelevant user-selected context
- Relevant retrieval and lexical false friends
- Passive style transfer and passive topic leakage
- Learned feedback preferences
- Newer corrections overriding stale conversation history
- Cross-user canary suppression
- Indirect prompt injection inside memory
- Language isolation
- Explicit-current-context precedence over contradictory passive history

These cases run through the same production system, mode, platform, language, conversation, selected, related, passive, and feedback message structure as the application. They should be evaluated with the existing deterministic gates and semantic rubric.

## Code findings

### Repeated embedding work

Saved-prompt search and passive-memory search receive the same current query. The code claimed to cache this embedding, but the LRU decorator was attached to `embedding_status()` instead of embedding generation. That meant the expensive local encoding could run twice per enhancement, while health status itself could become stale.

The cache now stores immutable tuples and returns a fresh list to callers. Status reports live hit, miss, and size counters. Tests prove identical queries encode once, distinct queries remain distinct, callers cannot mutate the cached vector, and loaded status changes truthfully.

### Threshold mismatch

The former 0.40/0.50 cutoffs favored clean abstention but removed half of relevant context. Passive memories were especially affected because a past prompt and a current query often share intent or style without high lexical similarity. Configurable 0.24/0.20 defaults pass the initial corpus while preserving abstention.

Thresholds should be monitored by source. A single global threshold would hide the fact that saved facts and passive patterns have different score distributions and different costs when wrong.

### Untrusted context

The production system prompt resisted injection in the current user text but did not explicitly label every retrieved layer as untrusted. It now names conversation history, saved prompts, passive patterns, and feedback as data that cannot override the current request. The context task instruction now applies relevance filtering to every layer, not only selected and related saved prompts.

## Fast execution strategy

The default unit suite does not load Torch, download model weights, call Qdrant Cloud, invoke the rewrite model, consume shared quota, or write product analytics. Deterministic tests validate corpus shape, metric calculations, privacy gates, threshold boundaries, context-message construction, and embedding-cache behavior in under a second on the development machine.

The semantic retrieval benchmark is an explicit slower lane. It loads the same embedding model as production, batch-embeds the 18 memories once, measures warm per-query ranking latency, and writes optional JSONL evidence outside the repository. The generation benchmark remains a separate BYOK lane because it consumes model tokens.

```bash
# Fast pull-request checks
pytest tests/test_context_retrieval_eval.py tests/test_embedding_cache.py -q
python evals/run_context_retrieval_eval.py --validate

# Smoke-test metric calculations against ideal rankings
python evals/run_context_retrieval_eval.py --oracle

# Actual production embedding benchmark; no LLM call or product logging
python evals/run_context_retrieval_eval.py --semantic-local

# Context-aware rewrite-model benchmark with a dedicated provider key
PROMPT_EVAL_BYOK_KEY=... python evals/run_direct_prompt_eval.py \
  --cases evals/context_behavior_cases.json
```

## Remaining limitations and next measurements

- The current threshold result is calibrated and evaluated on the same 24 cases. Expand to at least 100 anonymized, consented judgments and preserve a held-out test split before treating 0.24/0.20 as stable.
- The local semantic run measures the embedding and ranking policy, not Qdrant Cloud network latency. Production telemetry should separately record embedding time and each vector-query duration.
- The corpus has six people, not demographic labels. It tests product-use diversity without inferring sensitive traits. Future additions should vary language, expertise, verbosity preference, topic continuity, and memory volume—not protected characteristics unless there is an explicit fairness study and appropriate governance.
- Time-aware retrieval is not implemented. Corrections are tested at the model/context layer, but saved/passive vectors lack a recency-aware ranking signal.
- Context usefulness still requires generation evaluation. Passing retrieval gates does not prove that the rewrite model followed the right memory.
- Threshold changes alter which historical data reaches the model. Deploy behind a canary, watch context-related thumbs-down reasons, and retain immediate rollback through environment variables.

## Sources

[^1]: Shahul Es, Jithin James, Luis Espinosa-Anke, and Steven Schockaert. “[Ragas: Automated Evaluation of Retrieval Augmented Generation](https://arxiv.org/abs/2309.15217).” Revised April 28, 2025.
[^2]: Di Wu et al. “[LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory](https://arxiv.org/abs/2410.10813).” ICLR 2025; revised March 4, 2025.
[^3]: Alireza Salemi, Sheshera Mysore, Michael Bendersky, and Hamed Zamani. “[LaMP: When Large Language Models Meet Personalization](https://arxiv.org/abs/2304.11406).” Revised June 5, 2024.
[^4]: Edoardo Debenedetti et al. “[AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents](https://arxiv.org/abs/2406.13352).” Revised November 24, 2024.
[^5]: Qdrant. “[Filtering](https://qdrant.tech/documentation/search/filtering/).” Accessed September 11, 2026.
