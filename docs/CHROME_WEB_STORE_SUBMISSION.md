# Prompt Memory 4.4 — Chrome Web Store submission draft

Upload `dist/prompt-memory-4.4.zip` after verifying the exact ZIP in Chrome. The package is built by `python3 scripts/package_extension.py` and contains only runtime files.

## Single purpose and suggested listing

**Single purpose:** Help people turn drafts they write in supported AI chats into clearer prompts, with a review step before anything is inserted into the chat composer.

**Short description:** Rewrite a rough AI prompt in one click on ChatGPT, Claude, Gemini, Perplexity, or Grok. Review the result before using it.

**Detailed description draft:**

> A vague request can make a useful answer harder to get. Prompt Memory helps you clarify what you want while you stay in the AI chat you already use.
>
> Type a draft, press Enhance, and compare the rewrite with your original. Edit it, insert it, or dismiss it. For example, “explain this bug” can become a debugging request that asks for likely causes, a reproduction plan, and a minimal fix while preserving your code. The extension offers Quick, Deep, and Creative rewrite modes on ChatGPT, Claude, Gemini, Perplexity, and Grok.
>
> You can use your own Groq, Gemini, or OpenRouter API key without a Prompt Memory account. In that mode, the draft goes directly from your browser to your provider. Sign in with Google if you want saved prompts, enhancement history, conversation-aware rewrites, and voice transcription. When signed in, enhancement requests go through our server; recent chat messages are included for context by default and can be switched off. Prompt Tracking is off until you enable it.
>
> Provider limits and terms apply. Prompt Memory is independent of the supported chat platforms.

Use the comparison screenshot of a real, working rewrite rather than a synthetic mockup. Do not publish traffic, performance, or conversion claims without measured evidence. If verified install numbers later support “Join thousands,” record the dashboard measurement and date first; refresh or remove the claim if it becomes stale.

## Privacy tab: declarations to review

Declare the actual categories in the current dashboard UI. At minimum, assess: email/account identifiers, authentication tokens, user-provided drafts and saved prompts, website content or personal communications from recent chat messages, audio when Voice-to-Prompt is used, and feedback. The platform hostname is included in enhancement and tracking requests. Explain direct BYOK versus signed-in server routing and third-party AI processing. Certify Limited Use only after verifying the deployed backend and website match the policy.

**Permission justifications:** `storage` keeps consent, settings, session, and the user's own API key on this device. `scripting` activates the UI in supported tabs already open when the extension is installed or updated. Chat-site access powers the composer UI and optional recent-message context. API host access is for the Prompt Memory backend and direct BYOK calls to Groq, Gemini, or OpenRouter. `x.com` host access is for Grok at `/i/grok`; the content script and runtime guard limit behavior to that path.

The privacy-policy field needs a **public HTTPS URL** serving the updated `website/privacy.html`, preferably on the product's own website. The in-extension policy link currently points to the GitHub source page. Change it to the public policy URL once the website is deployed. Use `hello.promptmemory@gmail.com` as the developer contact and support address.

## Reviewer instructions draft

1. Install the ZIP and observe the first-run disclosure. Select **Agree & continue** to enable setup. No prompt is sent by this step.
2. On ChatGPT, Claude, Gemini, Perplexity, or Grok, type a harmless sample such as “Explain caching to a beginner.” Click the ⊕ button or use the shortcut. Review the rewrite and insert or dismiss it.
3. Select the prominent **Continue with Google** action with a test account, enhance a sample draft, and inspect History and the saved-prompt library. Voice requires sign-in and browser microphone permission; the transcript can be edited before enhancement.
4. Expand **Use your own API key instead** and enter a test provider key. This route requires no Prompt Memory account; signed-out requests go directly to that provider.
5. In the popup, select **Delete account & data**, type `DELETE`, and verify the account signs out after successful server deletion. Use a disposable review account. A store outage returns an incomplete-deletion message so the user can retry.

## Release checks still requiring a deployed environment

- Host the updated privacy policy and enter its URL in the dashboard. Confirm the link opens without a login.
- Confirm Google OAuth is in production mode, the redirect URI points to the live backend, and a fresh reviewer account can sign in. Confirm production CORS includes all five chat origins (plus `https://x.com` for Grok).
- Load the **exact ZIP** in a clean Chrome profile. Exercise first-run consent, direct and signed-in enhancement, keyboard shortcuts, voice, context and tracking toggles, and deletion. Test each supported site after navigation as well as after an update.
- Capture at least one real 1280×800 or 640×400 product screenshot for the listing. Do not use a design mockup as a screenshot of functionality.
- Complete the dashboard's Store Listing, Privacy, Distribution, and (if needed) Test Instructions tabs. Submission and review are Google-controlled; code changes cannot guarantee approval.
