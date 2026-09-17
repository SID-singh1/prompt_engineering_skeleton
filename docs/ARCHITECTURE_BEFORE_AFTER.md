# Prompt Memory: architecture before and now

Snapshot: 2026-09-13. “Before” means the last committed `main` revision,
`d419447` (`Document voice controls and dashboard metrics`), which was also
`origin/main` when this document was written. “Now” means the **local working
tree**, including uncommitted and untracked files. This is not a comparison
with the project's first version, and it does not imply the new behavior is
deployed to Hugging Face Spaces or installed in anyone's Chrome profile.

## The short version

The product remains a Manifest V3 Chrome extension backed by FastAPI. It
collects a draft prompt and optional conversation context, retrieves a user's
saved prompts and passive patterns, calls an LLM, and shows a rewrite the user
can apply. MongoDB holds logs and saved-prompt records; Qdrant holds semantic
vectors. The private builder dashboard, voice transcription/review flow,
authentication, provider fallback, and prompt library **already existed at
the before checkpoint**.

The current work changes a consequential boundary: generating a rewrite no
longer makes it trusted passive memory. The rewrite is logged and previewed;
only a successful application of the enhanced text triggers an authenticated,
owner-scoped approval. Retrieval then requires an `approved=true` vector.
Alongside that, the prompt policy and retrieval thresholds were adjusted, an
embedding cache was added, and a distinct `evals/` package was created to
measure retrieval separately from generation.

| Area | Before: committed `main` | Now: local working tree |
|---|---|---|
| Core stack | Chrome extension → FastAPI → LLM; MongoDB + Qdrant | Same stack and entry points |
| Rewrite result | Logged, returned to preview, and automatically memorized if saved-prompt similarity was below 0.90 | Logged and returned to preview; **not** memorized yet |
| Long-term passive memory | New Qdrant point from a generated rewrite, regardless of accept/dismiss | New point only after enhanced text is successfully applied and `/enhance/accept` verifies the user's own log |
| Passive retrieval | Qdrant filter by `user_id`, then a hard-coded 0.50 cutoff in the enhancement path | Filter by `user_id` **and** `approved=true`, then configurable 0.20 cutoff by default |
| Saved-prompt retrieval | Separate user-scoped Qdrant collection, hard-coded 0.40 cutoff | Same collection; configurable saved threshold of 0.24 by default |
| Rewrite instructions | Examples and Deep-mode guidance sometimes rewarded extra, unrequested detail | Source-fidelity rules and examples explicitly guard against invented titles, counts, audiences, or deliverables |
| Evaluation | Root-level ad hoc scripts/reports plus `tests/` | Existing scripts/tests remain; new `evals/` corpora, graders, runners, research notes, and held-out diagnostics are local/untracked |
| Voice and builder dashboard | Present already | Still present; neither was newly built in this local change set |

## Runtime flow: before

```text
User draft in supported AI site
  → extension/content.js captures draft + recent conversation
  → authenticated /enhance or /enhance/stream
  → context builder retrieves selected saved prompts, auto-matched saved
    prompts, passive patterns, and feedback summary
  → provider fallback generates rewrite
  → Mongo prompt log + immediate Qdrant passive-memory upsert
    (if top saved-prompt similarity < 0.90)
  → extension displays preview → user may apply, copy, or dismiss
```

The issue was ordering. The vector write occurred **before** the user judged
the rewrite. A dismissed or incorrect completion could appear as a past
pattern in a later request. The 0.90 check estimated similarity to a saved
prompt; it was not an approval or quality signal. Both regular and streaming
enhancement paths did the immediate write. The extension's “accept” action
applied text to the composer but did not tell the backend that the user had
done so.

## Runtime flow: now

```text
User draft in supported AI site
  → extension/content.js captures draft + recent conversation
  → authenticated /enhance or /enhance/stream
  → context builder retrieves selected/auto-matched saved prompts and only
    approved passive patterns, then builds a source-fidelity rewrite request
  → provider generates rewrite
  → prompt log gets an opaque log_id (Mongo, or an in-process fallback);
    no passive vector is written
  → extension displays preview
       ├─ dismiss / copy / apply original → no passive-memory approval
       └─ successfully apply enhanced text (or History → Use)
            → POST /enhance/accept with log_id only
            → server verifies user + active log, records accepted_at
            → idempotent Qdrant point with approved=true
            → future requests may retrieve that point
```

The server resolves the original/refined pair from its own log; the extension
does not submit arbitrary text as the memory authority. Repeated approval
uses a deterministic point ID, preventing duplicate vectors. If a configured
Mongo store cannot retain or recover the approval log, the durable vector
write fails closed. If Qdrant is unavailable, applying the text still works,
but memory is not saved; a later History → Use may retry. A near-duplicate
or unchanged rewrite can be accepted without making a new passive vector.

This is **application-gated**, not an explicit separate “Remember this”
consent control. The user can still apply a rewrite they later dislike, so
acceptance should not be treated as a perfect quality label.

### Data and trust boundaries

| Data | Owner/source | Where it goes now | Important rule |
|---|---|---|---|
| Current draft + conversation | Browser page, captured by extension | Both enter the authenticated enhance request; the draft is stored in the prompt log, while conversation is not a dedicated log field | Current user request and latest correction outrank remembered context |
| User-selected saved prompt | User-managed Mongo record | Context builder | More deliberate than auto-matched context; still untrusted text |
| Auto-matched saved prompt | User-scoped saved-prompt Qdrant collection | Context builder if relevant | Similarity is relevance evidence, not an instruction |
| Passive pattern | Approved Qdrant point in `prompt_memory` | Context builder if user and score match | Unapproved legacy points remain stored but are excluded from retrieval |
| Generated rewrite | Provider output | Preview + prompt log | Generation alone does not authorize memory |
| Approval | Extension sends opaque `log_id` after successful apply | Authenticated `/enhance/accept` → log state → Qdrant point | Server checks ownership and resolves text; retries reuse point ID |
| Feedback thumbs up/down | Existing feedback endpoint/collection | Feedback summary | Currently **does not** revoke an already-approved vector |

Signed-in users with their own provider key still use the backend enhancement
path and retain memory. An anonymous/direct-provider BYOK path is separate;
the approval flow described here concerns server-backed, authenticated
enhancements. The private builder dashboard is a separate key-protected
read-only aggregate view; it existed before and is **not** a user-facing
memory-approval UI.

## Repository shape

At the before checkpoint the main folders were `extension/`, `backend/`,
`website/`, and `tests/`, plus numerous root-level experiment scripts and
reports. Those folders remain. The current working tree adds a focused
evaluation area and tests; it has not moved the application into a new
framework.

Before (`d419447`), summarized rather than listing every file:

```text
promptengine/
├── extension/       Chrome UI, voice flow, composer integration
├── backend/         FastAPI routes, provider chain, Mongo/Qdrant services
├── website/         public site and private builder dashboard page
├── tests/           API, vector, UI-static, quota, security tests
└── root-level scripts + reports   model experiments mixed at top level
```

Now (local working tree; additions and changed paths highlighted):

```text
promptengine/
├── extension/                  existing Chrome UI and service worker
│   └── content.js              changed: approval call after successful apply
├── backend/                    existing FastAPI application
│   ├── main.py                 unchanged router registration
│   ├── routers/
│   │   ├── prompts.py          changed: policy; log-first; new /enhance/accept
│   │   └── builder_dashboard.py existing private dashboard (unchanged here)
│   ├── services/
│   │   ├── memory_service.py   changed: owner-scoped approved memory lifecycle
│   │   └── llm_service.py      changed: reusable embedding cache
│   └── core/
│       ├── config.py           changed: saved/passive retrieval thresholds
│       └── database.py         changed: user_id + log_id lookup index
├── website/                    existing public site + private builder page
├── tests/                      existing suite plus new memory/eval tests
├── evals/                      NEW, untracked evaluation package and reports
└── docs/                       this architecture handoff document
```

Other touched files include the approval request schema and API/static
regression tests. The existing root-level test scripts and historical reports
have **not** been consolidated into `evals/`; both sets currently coexist.
The top-level README's short folder sketch predates several existing
components, so use this document for the before/now comparison rather than
treating that sketch as a complete inventory.

## Quality/evaluation structure: before versus now

Before, there were already unit/integration tests and a collection of
root-level model comparison scripts and JSON/Markdown reports. They could
find regressions but did not cleanly separate “was the right memory found?”
from “did the model use that memory faithfully?”

The new local `evals/` area separates those questions:

1. `prompt_improvement_cases.json` and `prompt_eval.py` cover broad rewrite
   invariants: intent, negatives, numbers, code, language, mode, and output
   shape. The corpus has 82 curated cases; objective checks are not a
   substitute for semantic review.
2. `context_retrieval_cases.json` and `context_retrieval_holdout.json` contain
   multi-person synthetic memory selection cases. The retrieval runner
   reports positive-case precision/recall separately from no-match
   abstention, avoiding inflated scores from empty-result cases.
3. `run_context_generation_eval.py` compares generation with and without
   controlled context. `run_three_arm_context_eval.py` compares none,
   human-labeled oracle context, and **locally retrieved** context. It records
   model, prompt/request hashes, selected memory IDs, provider errors, and
   raw synthetic outputs for later human review. It is not a production
   Qdrant/API/Chrome end-to-end runner.
4. New tests cover corpus validity, retrieval isolation, fixture provenance,
   resume safety, approval ownership/idempotence, and the extension's
   approval-after-apply wiring.

The first six-person, 18-call generation diagnostic found unsupported detail
and inconsistent context use, but its saved-prompt fixture mistakenly exposed
synthetic IDs as titles. That run is a bug-finding baseline, **not** a clean
quality estimate. A corrected one-case museum diagnostic produced a shorter
no-memory rewrite and context-aware outputs without the fabricated formal
title. One case cannot establish an overall improvement. See
[`evals/HELDOUT_2026-09-13.md`](../evals/HELDOUT_2026-09-13.md) for the exact
method, findings, and limitations.

## What the new structure has not solved

- The current changes are local: no commit, push, Space deployment, or
  isolated Chrome end-to-end run is evidenced by this snapshot.
- The approval API and extension are covered by automated tests, but the
  real composer/application path was not retested in a clean Chrome profile.
- An `approved=true` filter hides older passive vectors; it does not delete
  their stored text or provide user-facing memory management.
- Thumbs-down feedback does not revoke an approved vector. Prompt-log TTL
  can also expire the Mongo approval record before the Qdrant point, leaving
  a long-term audit/retention mismatch.
- The local retrieval benchmark is small and synthetic. The new threshold
  defaults and policy changes still need a fresh, untouched, blinded human
  evaluation and production Qdrant/API validation before a release claim.
- Operational logging and the existing builder dashboard remain useful, but
  approval success/failure and downstream rewrite quality are not yet a
  complete builder-visible quality funnel.

## Practical next handoff

Keep this working tree separate from claims about `main`. First review and
stage the intended files, then run the automated suite and an isolated
Chrome/API test identity. Next, build a minimal long-lived approval ledger
and user-facing revocation/deletion path so memory lifetime and consent
records agree. Finally, evaluate the revised prompt/retriever on a **new**
untouched corpus with blinded semantic labels; the inspected development
cases cannot serve as an unbiased release gate.
