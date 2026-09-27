# Saved-prompt matching with template libraries (2026-09-24)

A tester's rewrite of an unrelated prompt ("Imagine that tomorrow, every
person on Earth wakes up …") reported "3 saved prompts used". This note
records why it happened, what was measured, and why the production threshold
did not change.

## What was measured

The production embedding (`paraphrase-multilingual-MiniLM-L12-v2`, cosine)
was scored against six **template-style** saved prompts ("Review this diff
like a senior engineer…", "Explain the concept step by step…", and so on), on:

- 12 unrelated prompts that should attach nothing (travel, recipes, essays,
  the tester's prompt), and
- 8 prompts that should match one template ("look over this pull request
  diff", "my app crashes right after login").

| Rule | Wrong attachments on 12 unrelated prompts | Right template found (of 8) | Extra attachments on the 8 |
|---|---|---|---|
| **Production: ≥ 0.24, up to 3** | **10** | 4 | 2 |
| ≥ 0.30, up to 3 | 5 | 4 | 2 |
| ≥ 0.35, up to 3 | 2 | 3 | 1 |
| ≥ 0.24, others within 0.10 of the best | 9 | 4 | 0 |
| ≥ 0.24 for the best, ≥ 0.45 for the others | 4 | 4 | 0 |
| ≥ 0.30 for the best, ≥ 0.45 for the others | 3 | 4 | 0 |

Two things stand out. Instruction-shaped templates score 0.25–0.38 against
*any* long instruction-shaped prompt, because they share phrasing rather than
topic. And the right template often scores low (0.07 for "look over this pull
request diff" against the code-review template), so similarity is a weak
signal for templates in either direction.

## Why production stayed at 0.24

The official corpora (`context_retrieval_cases.json`, 24 cases, and
`context_retrieval_holdout.json`, 18 cases) hold fact-style memories, where
0.24 is the best setting measured:

| Rule | Calibration P / R / MRR | Gate | Held-out P / R / MRR | Gate |
|---|---|---|---|---|
| ≥ 0.24, up to 3 | 0.843 / 0.917 / 0.917 | pass | 0.833 / 1.000 / 0.958 | pass |
| ≥ 0.30 | 0.778 / 0.778 / 0.833 | fail | 0.833 / 1.000 / 0.958 | pass |
| ≥ 0.24 best, ≥ 0.45 others | 0.833 / 0.833 / 0.889 | fail (recall, entity resolution) | 0.833 / 1.000 / 0.958 | pass |

Every stricter rule that helps with templates costs recall on fact-style
memories. The synthetic template set is 20 prompts written by one person,
which is too little to trade a measured loss for.

## What changed instead

- The card names every saved prompt that shaped a rewrite, marks each as a
  close (≥ 0.5) or loose match, and lets the user drop one ("Don't use"),
  which reruns without it (`excluded_prompt_ids`).
- A saved prompt already contained in the draft, or scoring ≥ 0.97, is no
  longer sent back as "related" (`_already_in_prompt` in
  `backend/services/prompt_builder.py`).

## Next

Add consented, human-labelled template-style cases (a library of generic
instructions, with unrelated and related queries) to the corpus, then
recalibrate. A rule that treats templates and facts differently (for example
a higher bar for the second and third match) is the leading candidate.
