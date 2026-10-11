# Prompt Memory 5.0 — Chrome Web Store submission

Upload `dist/prompt-memory-5.0.0.zip`, built by `python scripts/package_extension.py`. It contains only runtime files (no test harnesses).

**Publish as Unlisted first.** Only people with the link can install it, it does not appear in search, and early reviews do not shape the public listing. Switch Distribution → Visibility to **Public** once a handful of testers have used it without help. Every later update goes through review again (usually hours to a few days); updates that add permissions get a closer look and show users a new warning, so add permissions only when needed.

## What changed in 5.0, for the listing and the privacy form

- **Works on install, no account, no key.** Without signing in, Improve sends the text in the chat box to our server, which rewrites it with Groq and sends it back. Quick style only, a small daily limit, and **nothing is stored**: not the draft, not the rewrite, not in logs.
- **Improve sits on the chat box.** One click rewrites the draft in place; Undo puts back exactly what was typed. Library, styles, voice and settings are under ⋯.
- **Consent is asked on first use**, on the chat page, in two sentences that describe what that press sends. Nothing is sent before the answer.
- **Signing in (free) adds** more rewrites, the Deep and Creative styles, a saved-prompt library reusable with `//`, History, and voice.

## Order of operations (do these in order)

1. **Deploy the backend first.** The 5.0 extension calls `POST /auth/anonymous`, which older backends do not have; shipping the extension first makes every signed-out Improve fail. Merge, let the Hugging Face Space sync, and check `GET /` reports `"version": "5.0.0"`.
2. **Configure the server key and caps** on the Space:
   - A paid (or higher-tier) `GROQ_API_KEY`. The free tier's org-wide limits (~1,000 requests/day) are shared by every free user.
   - `ANON_DAILY_LIMIT` (default 10 per install), `ANON_GLOBAL_DAILY_LIMIT` (default 2000 across all anonymous installs: this is the cap that bounds spend), `ANON_MINT_PER_HOUR` (default 10 new tokens per address).
   - Set a monthly spending limit in the Groq console too. The global cap bounds requests; the console bounds money.
3. **Publish the privacy policy** (`website/privacy.html`, updated 11 October 2026 for the no-account tier) at its public URL, `https://prompt-engineering-skeleton-seven.vercel.app/privacy`. Open it logged out to confirm.
4. **Test the exact ZIP** in a clean Chrome profile (Load unpacked from the extracted ZIP): install → home tab says "You're all set" → on ChatGPT, Claude and Gemini: type, Improve, consent, rewrite lands, Undo → sign in → library and `//`.
5. **Take real screenshots** (1280×800) on the real sites, not the harness. Suggested set: (1) a rough draft with Improve on the chat box, (2) the rewrite in the box with "Improved · Undo · Compare", (3) Compare open beside the original, (4) `//` inserting a saved prompt, (5) the popup's home screen.
6. **Fill in the dashboard** (Store listing, Privacy, Distribution = Unlisted), upload the ZIP, submit.

## Store listing

**Name:** Prompt Memory

**Summary (manifest description, 124/132 characters):** Make a rough AI prompt clearer in one click, right in ChatGPT, Claude, Gemini, Perplexity and Grok. Free, no account needed.

**Category:** Productivity (or Tools).

**Description:**

> Type a rough draft in ChatGPT, Claude, Gemini, Perplexity or Grok and press Improve. Prompt Memory rewrites it into a clearer prompt, right in the chat box. Don't like it? Undo puts back exactly what you typed.
>
> It's built to keep your meaning: it rewrites your question rather than answering it, and aims to keep your numbers, names, code and language (Hinglish included) exactly as you gave them. Always read the rewrite before you send it.
>
> Free, with no account and no API key: Quick rewrites, a few each day, and nothing you type is saved.
>
> Sign in with Google (also free) for more:
> • More rewrites every day
> • Deep and Creative styles
> • A library of your prompts and details, inserted anywhere by typing //
> • History of your rewrites, and voice input
>
> Your data: nothing is sent until you press Improve, and the first time you're asked. Without an account, only the draft is sent and nothing is stored. Signed in, your drafts and rewrites are kept in your History, with a few recent chat messages for context (which you can turn off). Prompt tracking is off unless you turn it on. Full policy: https://prompt-engineering-skeleton-seven.vercel.app/privacy
>
> Prompt Memory is independent and not affiliated with OpenAI, Anthropic, Google, Perplexity or xAI.

Do not add usage numbers, testimonials or quality claims ("10x better prompts") without measured evidence; reviewers and users both punish them.

## Privacy tab

**Single purpose:** Rewrite the draft a user has typed into a supported AI chat's message box into a clearer prompt, when they press Improve, and let them reuse their own saved prompts there.

**Permission justifications:**

- `storage` — the user's settings, consent, sign-in session, the anonymous free-tier token, and (optionally) their own API key, kept on this device.
- `scripting` — on install or update, adds the Improve button to supported chat tabs that were already open, so the user does not have to reload them. Tabs that already have it are skipped.
- Host access to the five chat sites (and `x.com/i/grok*` for Grok) — to place the Improve button on the chat box and write the rewrite into it; when signed in, to read the last few messages for context.
- Host access to `siddhm11-prompt-engine.hf.space` — Prompt Memory's own server: rewrites, the free-tier token, sign-in, library and history.
- Host access to `api.groq.com`, `generativelanguage.googleapis.com`, `openrouter.ai` — only used when the user adds their own API key and is not signed in, to send the draft directly to that provider.

**Remote code:** No. All code ships in the package.

**Data collected (tick what the dashboard offers, matching these):**

| Category | When | Stored? |
|---|---|---|
| Website content / user-typed text (the draft) | When the user presses Improve | Without an account: no. Signed in: in History. |
| Personal communications (recent chat messages) | Signed-in rewrites only, unless turned off | Sent with that request; not kept as a profile |
| Personally identifiable info (email) | On Google sign-in | Yes, to identify the account |
| Authentication info | Sign-in token; anonymous token | On the device |
| Audio | Voice input, signed in, when recording | No; transcribed and discarded |
| User activity (ratings, feedback) | When the user submits them | Yes |

Certify: not sold, not used for unrelated purposes, not used for creditworthiness. Only certify Limited Use after checking the deployed backend matches the policy (in particular: anonymous rewrites are not logged, which `tests/test_anonymous_tier.py` checks).

## Reviewer test instructions

1. Install. A tab opens: "You're all set". No sign-in is needed.
2. Open https://chatgpt.com (or claude.ai, gemini.google.com). Type a harmless draft such as "explain caching to a beginner" in the message box. Do not send it.
3. Press **Improve** on the chat box (or Ctrl+Shift+E). The first time, a short notice says what is sent; choose **OK, improve it**. The draft is replaced by a clearer version. **Undo** restores the original. Nothing is sent to the chat site.
4. Optional: open ⋯ → **Sign in with Google for more** with a test Google account. ⋯ then shows the library; save a prompt, then type `//` in the message box to insert it.
5. Optional: toolbar icon → **Settings and privacy** → **Delete account and data**, type DELETE, to remove the test account.

## Known gaps to check before going Public

- Real-site verification: the end-to-end checks run on a ChatGPT-shaped fake page. Each real site's chat box changes often; test all five by hand on the exact ZIP.
- `scripts/check_editors.py` reports a stray trailing blank line after `//` insertion in the Lexical editor (used by Perplexity, we believe). It was already failing on `main` before 5.0.
- The anonymous daily tally lives in the server process's memory: a restart resets it, which errs toward the user. Move it to Mongo before running more than one worker.
