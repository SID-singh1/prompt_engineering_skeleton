# Controlled context-generation baseline — 2026-09-12

This is a **direct-provider generation** experiment, not a production API or
retrieval test. The 12 synthetic cases each ran twice against the literal
production rewrite prompt: once without context and once with hand-authored
context. Arm order was counterbalanced. The provider model was
`qwen/qwen3.8-27b`; temperatures followed production mode settings. All 24
final requests returned HTTP 200. Seven initially rate-limited requests were
retried and the 17 successful prior responses were reused. The ignored raw
result file was `/private/tmp/promptengine-context-complete-20260912.jsonl`.

The deterministic checks passed 7/12 no-context outputs and 9/12
controlled-context outputs. These counts are **not a preference score**:
context-dependent facts are intentionally unavailable to the no-context arm,
and lexical checks miss semantic errors. Each output still requires review.
The model is stochastic, and one run per arm cannot establish significance.

## What the pairs showed

- Relevant context improved specificity in the invoice, B2B launch, SQL style,
  feedback-preference, and corrected-rollout cases. The feedback example
  became short instead of a 107-word multi-section comparison prompt.
- The irrelevant vegetarian-dinner, snake-story, and job-interview memories
  were not visibly copied. The single cross-user canary and retrieved
  instruction-injection cases did not leak or obey the injected material.
  This is a smoke test, not a security guarantee.
- The romanised-Hindi case produced an English rewrite **with** irrelevant
  English saved context, while the no-context rewrite stayed in Hinglish.
  The old scorer missed this; it now emits a language-switch review warning.
- The controlled B2B launch rewrite introduced unprovided customer pain points
  and three output variants. The invoice rewrite called Friday
  “non-negotiable,” which was not stated. The launch-email rewrite assumed
  conversion to paid plans and invented a 150-word limit. These are plausible
  additions, but they change the user's request rather than merely clarify it.
- Deep-mode outputs were often too long. The corrected-rollout prompt carried
  the newest 10%/November correction, but added five sections and exceeded
  its 90-word case limit. The original scorer also incorrectly treated “do
  not launch to all customers” as introducing “all customers”; the scorer now
  routes explicitly negated mentions to human review instead of hard failure.

## Next decision

Revise the production rewrite instructions to prioritize source fidelity,
language, and proportionality over added structure. Re-run these cases as a
development set, then validate on separate held-out prompts and the real
retrieval/API path. Do not claim a 10/10 product or a production-quality win
from this small synthetic baseline.

The direct evaluator uses the ignored `backend/.env` only for the dedicated
evaluation key and never writes requests to product memory, logs, or the
builder dashboard. The key is not included in this report or raw results.

## First prompt revision (same-day development check)

The rewrite instructions were changed to prioritize the current user's facts,
latest correction, language, and proportionality over optional detail. Five
failure-focused cases were rerun, again with both arms (10 successful calls).
Under the updated deterministic scorer, controlled-context passes changed
from **3/5 baseline to 5/5 candidate** on those *same* cases. This is a
development-set comparison, not held-out evidence; one stochastic output per
condition can also change by chance. The ignored candidate file was
`/private/tmp/promptengine-context-candidate-20260912.jsonl`.

Manual comparison:

- The invoice case no longer declared the Friday deadline “non-negotiable.”
- The B2B launch case stopped inventing customer pain points, but still asked
  for an unrequested 3–5 variants. This remains a source-fidelity defect.
- The corrected rollout remained anchored to 10% of beta users in November
  and became shorter. Mentioning the cancelled old rollout is not a leak.
- The romanised-Hindi output stayed in Hinglish, although phrasing was not
  perfectly natural.
- The launch email stopped assuming conversion to paid plans and an arbitrary
  150-word limit. It still added a broader ban on pricing details beyond the
  user's narrower “no discounts” constraint.

Do not ship this as a proven overall quality win yet. Next run a held-out
generation set, inspect semantic ratings from at least two reviewers, and
exercise the real authenticated retrieval/API path. The prompt revision is
left uncommitted for that follow-up.
