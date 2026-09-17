# Prompt Memory Quality Assessment and Development Strategy

> Historical assessment written before the 2026-09-12/13 provider runs and
> acceptance-gated passive-memory change. Statements below that say no
> evaluation key or provider result existed are dated observations, not the
> current project state. See `CONTEXT_GENERATION_BASELINE_2026-09-12.md` and
> `HELDOUT_2026-09-13.md` for subsequent evidence.

## Executive assessment

Prompt Memory's product promise is not to make every prompt longer. It is to produce the smallest useful rewrite while preserving the person's intent, constraints, uncertainty, language, and control over private context. A credible “10/10” product would consistently make the downstream interaction better, not merely produce polished-looking text.

The present evidence does **not** establish that level of quality. Eleven verified production Chrome rewrites produced seven deterministic passes; one changed unspecified “interview questions” into “technical interview questions.” A separate synthetic context benchmark showed that the former retrieval thresholds missed much relevant context. New candidate thresholds improved retrieval substantially, but they were chosen and evaluated on the same small corpus. Most importantly, the 12 context-aware generation cases have **not** been run against the provider model: the local workspace has no evaluation key, and running them through a personal Chrome account would require altering that account's memory. This is a measurement gap, not a failure or success of the context-conditioned model.

The strongest recommendation is to make improvement conditional on evidence: compare each case without memory, with hand-selected correct memory, and with the actual retrieved memory. This isolates retrieval, utilization, and the net user-visible effect. Research on RAG evaluation explicitly distinguishes retrieval from faithful use and generation quality; a single blended score hides the failure stage.[^1][^2]

## Evidence already available

| Evidence | Result | Interpretation |
|---|---|---|
| Production Chrome rewrite sample | 7/11 deterministic passes | Real output quality has identifiable failures; sample is too small for a product-wide rate. |
| Production embedding, old thresholds | Positive-case precision 0.444; recall 0.333; MRR 0.444 | Many relevant memories never reached the rewrite model. |
| Production embedding, candidate thresholds | Positive-case precision 0.843; recall 0.917; MRR 0.917 | Promising local retrieval candidate, not a held-out generalization result. |
| No-context retrieval cases | 6/6 abstained under both settings | This small synthetic slice showed no regression in abstention. |
| Cross-user retrieval in local benchmark | Zero leaks | The tested search path preserved tenant filtering; this does not prove every production path is leak-free. |
| Context-aware generation | No provider run | There is no measured final-prompt gain from memory yet. |
| Local retrieval latency | Candidate warm p95 about 21 ms | Excludes model load, Qdrant network, provider generation, browser UI, and cold starts. |

The retrieval score correction matters. An earlier evaluator gave perfect precision and recall credit to empty-result cases. That inflated the headline figures to 0.882 precision and 0.938 recall for the candidate. The evaluator now calculates those metrics on the 18 cases that need context and reports abstention independently.

## Why retrieval quality alone is insufficient

The production context builder can add recent conversation, explicitly selected saved prompts, up to three auto-matched saved prompts, up to three passive patterns, and a feedback summary. It sends these layers together to the rewrite model. A vector similarity score indicates semantic proximity, not whether an old prompt is authorized to change the current request. RAGChecker finds that better retrieval can increase exposure to relevant noise and that generator utilization must be measured independently.[^2]

Three distinct errors can yield the same bad rewrite:

1. **Retrieval miss:** a needed constraint never arrives. A pricing preference can disappear despite a memory existing.
2. **Utilization miss:** the right memory arrives but the model ignores it, overuses an irrelevant neighbor, or treats old text as a current instruction.
3. **Policy miss:** the model follows all supplied context but still adds unauthorized specifics, as occurred in the no-context Chrome sample.

The current `context_used` response field counts retrieved and supplied items, not facts actually used in the rewrite. The extension displays a chip describing a saved prompt as having shaped the result when a match is present. That wording is stronger than the instrumentation can verify. It should be renamed to “context considered” unless attribution is established by a reviewable comparison or more rigorous tracing.

## Architecture risks found in the code

### Source precedence is underspecified

The current request, current corrections, and explicit negative constraints should outrank memories. Explicitly selected context should generally outrank automatically retrieved history; passive patterns should be weak style evidence, not a source of new facts. The code has an injection warning but no structured precedence policy. A model can therefore blend contradictory sources and still appear fluent.

Conversation extraction also groups the last three user messages and appends the last assistant message. This does not preserve full chronological order. A stale assistant turn can appear after a newer user correction in the constructed prompt. The correction tests exist, but the provider model has not yet been run on them.

### Passive memory can reinforce model errors

After a successful enhancement, the backend memorizes the original and refined prompt whenever the top saved-prompt similarity is below 0.90. The condition does not depend on user acceptance or positive feedback. An over-expanded or mistaken rewrite can become a future “past pattern,” causing feedback loops. Separating *verified stable preference*, *task facts*, and *unapproved prior outputs* would reduce that risk.

### More memory increases the attack and noise surface

Retrieved content is untrusted data even if it was saved under the user's account: it may include copied text, stale claims, or an injection. AgentDojo's threat model demonstrates why instructions embedded in external content must not receive the authority of the current task.[^3] The new explicit prompt warning helps, but prompt text alone is not a security boundary. Tenant filtering, data minimization, adversarial fixtures, and safe output handling remain necessary.

The long-context literature also shows that relevant information's position can materially affect use. Supplying more context is not a free quality gain, particularly when important corrections sit among irrelevant examples.[^4]

### Current threshold evidence is overfit

The 0.24 saved / 0.20 passive candidate was chosen after inspecting the same 24 synthetic cases used to report success. Its apparent gain is real on those cases, but it is not an unbiased estimate of future users. It should remain configurable and be tested on a held-out set with longer user histories, near-duplicate distractors, source-specific score distributions, other languages, and memory-age variants. Qdrant supports exact tenant payload filtering and tenant indexing; tenant isolation is an invariant independent of any similarity threshold.[^5]

### Feedback data is too weak to personalize reliably

The current feedback summary distinguishes mostly thumbs-up versus thumbs-down and includes snippets of disliked original prompts. It does not know *why* the user disliked a rewrite. A thumbs-down on a calculus prompt should not necessarily change the user's next travel prompt. Collecting a small, optional reason (“changed my intent,” “too long,” “missed my context,” “wrong language/tone,” “format broke”) is more actionable than treating every rating as a global preference.

### Real end-to-end latency is not measured by the local benchmark

The embedding cache fix removes repeated encoding of the same query, but the application still makes distinct saved and passive vector searches, reads feedback, calls the provider, and waits for browser UI. A 21 ms warm local embedding benchmark cannot stand in for a user's perceived latency. Instrument p50/p95 for each stage with metadata only; avoid adding raw prompt text to operational logs.

## Experiment needed before a model or threshold decision

### Paired, three-arm design

For each labeled request, use the same rewrite model, prompt policy, temperature, platform, language, and output budget:

| Arm | Memory supplied | Question answered |
|---|---|---|
| A: none | No saved/passive memory | How good is the base rewriter? |
| B: oracle | Only human-labeled relevant memory | Can the model use correct context safely? |
| C: actual | The application's real retrieval result | What net benefit does the shipped pipeline deliver? |

On a subset, add a fourth arm with realistic distractors. Compare A→B to estimate the model's ability to use good context and B→C to estimate retrieval damage. A→C is the product-level gain or regression. Repeat stochastic runs or fix a consistent seed where supported; randomize review order and hide the arm identity.

The immediate 12 context behavior cases are suitable as a smoke test but too small for a release claim. Expand with at least 100 held-out, human-labeled cases and six-plus diverse synthetic personas before threshold/model selection. Test short and long histories, stale and corrected facts, negative constraints, other languages/scripts, no-match prompts, explicit selected context, and near misses. Keep evaluation users separate from production analytics and memory.

### Scoring and release policy

Deterministic checks should gate exact quantities, code blocks, literal forbidden content, schema shape, language script, and cross-user canaries. Human reviewers should score intent fidelity, constraint preservation, appropriate context use, proportionality, and downstream usefulness. LLM judges can assist but must be calibrated against human judgments, with candidate order swapped and verbosity controlled; both position and length biases are documented.[^6][^7]

Recommended **provisional** release gates, to be revised after human calibration:

- Zero cross-user memory exposures or credential/system-prompt leaks in the test suite.
- Zero material invented facts or dropped explicit negative constraints in high-risk slices.
- Context arm C must beat or tie arm A on at least 90% of requests that genuinely need memory, and must not degrade no-memory requests.
- Positive-case retrieval recall ≥ 0.90 and precision ≥ 0.85 on a held-out set; abstention ≥ 0.95, reported separately.
- No meaningful regression in Quick mode, voice correction, Hinglish, code preservation, or already-clear prompts.
- Measured end-to-end p95 must fit a product target chosen from real usage; a local embedding p95 is not the target.
- A paired, blinded human preference improvement with uncertainty bounds, not just a better automatic score.

These are product goals, not claims the current system meets. A literal universal “10/10” is not measurable; the practical target is a system that rarely changes intent, reliably abstains from irrelevant context, improves users' next AI response, and makes failures visible and reversible.

## Prioritized development sequence

### 1. Establish trustworthy evidence

Run the 12 context-aware generation cases against the configured primary model using a dedicated evaluation key. Save case ID, prompt-policy version, model ID, provider, output, latency, token usage, and deterministic score—never the key. Review each failure manually. Then collect a held-out set before changing the thresholds again. The current workspace has no provider key, so this run is outstanding.

### 2. Make context selection explicit and economical

Treat user-selected context as a deliberate input; retrieve remaining context by source; deduplicate; budget tokens; and filter passive patterns more aggressively for topic-versus-style contamination. Consider a small reranker or typed preference store only after the held-out evaluation shows threshold tuning is insufficient. Do not add a new model call on every enhancement merely because it sounds sophisticated; compare quality gain against latency and cost.

### 3. Rewrite the model policy around an intent contract

Before rewriting, identify immutable facts, quantities, exclusions, language, requested output, and unknown fields. Do not infer a technology, audience, deadline, budget, geography, or conclusion. Deep mode should add structure without adding facts; Creative mode should preserve exclusions; Quick mode should often leave an already-good prompt nearly unchanged. The production prompt's current “infer intent and make specific” instruction and example outputs encourage the exact overreach seen in Chrome.

### 4. Prevent memory self-poisoning

Do not turn every generated rewrite into a trusted preference. Keep passive examples clearly marked as unapproved historical outputs, require acceptance/positive feedback for durable style learning, add recency or supersession for corrections, and provide deletion/disable controls. Avoid expanding prompt logging merely to improve metrics; metadata and consented, redacted failure samples are enough for most operational analysis.

### 5. Verify the actual Chrome experience

Test composer extraction, multiline code preservation, preview/edit/accept/reject flow, stale-result detection, and all supported sites. One live automation run corrupted a multiline code prompt before it reached the model; that incident should have its own browser-level regression test. Product quality ends at the user's composer, not at the provider API response.

## Decision record

The present best next action is **not** a model swap or another global threshold sweep. It is a paired context-generation baseline plus a held-out retrieval set. If oracle context improves quality but actual context does not, fix retrieval. If neither improves quality, fix context-utilization instructions or model selection. If both improve quality but latency becomes unacceptable, optimize context selection and critical-path calls. This decision tree prevents attractive but poorly targeted changes.

## Sources

[^1]: Shahul Es, Jithin James, Luis Espinosa-Anke, and Steven Schockaert. “[Ragas: Automated Evaluation of Retrieval Augmented Generation](https://arxiv.org/abs/2309.15217).” Revised April 2025.
[^2]: Dongyu Ru et al. “[RAGChecker: A Fine-grained Framework for Diagnosing Retrieval-Augmented Generation](https://arxiv.org/abs/2408.08067).” 2024.
[^3]: Edoardo Debenedetti et al. “[AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents](https://arxiv.org/abs/2406.13352).” Revised November 2024.
[^4]: Nelson F. Liu et al. “[Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172).” 2023.
[^5]: Qdrant. “[Multitenancy](https://qdrant.tech/documentation/manage-data/multitenancy/).” Accessed September 2026.
[^6]: Lianmin Zheng et al. “[Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685).” 2023.
[^7]: Yann Dubois et al. “[Length-Controlled AlpacaEval: A Simple Way to Debias Automatic Evaluators](https://arxiv.org/abs/2404.04475).” 2024.
[^8]: OpenAI. “[Prompt optimizer](https://developers.openai.com/api/docs/guides/prompt-optimizer).” Accessed September 2026. Supports an iterative evaluation-and-annotation approach; it does not validate these specific product thresholds.
