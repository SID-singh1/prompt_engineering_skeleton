# Prompt Memory: Chrome Web Store listing (Unlisted test release)

Everything to paste into the Chrome Web Store developer dashboard, in the
order the dashboard asks for it. Written for the **`store-listing` branch**:
`origin/main` at `6ff5595` (version 4.12.0) plus three release fixes on top
(the manifest summary below, the privacy policy brought up to date, and the
server no longer writing prompt text to its logs). The product itself: a consent screen and Google sign-in first (15 free
rewrites a day) or your own API key; the ⊕ in the page's corner; a card that
shows the rewrite with Replace draft, other styles, versions, save, rating,
and the saved prompts that shaped it. If you upload a different commit,
check the lines marked ✎.

Assets in this folder:

| File | What it is | Where it goes |
|---|---|---|
| `store-icon-128.png` | 128×128, artwork 96×96 centred with transparent padding, as Google asks | Store listing → Store icon |
| `logo-512.png` | 512×512 version of the mark | Your developer / Google profile picture |
| `promo-small-440x280.png` | Small promo tile | Store listing → Small promo tile (required) |
| `promo-marquee-1400x560.png` | Marquee tile | Store listing → Marquee promo tile (optional) |
The mark is the extension's own ⊕: the mint-to-violet tile with a white
ringed plus, the same as its toolbar icon, the popup header and the privacy
page. Source: `src/assets.html`; rerun `python docs/store/src/render_assets.py`
after a change.

`screenshot-1280x800.png`: one ready-made screenshot (Store listing →
Screenshots): the real extension's card, with a rewrite, Replace draft, the
other styles and the context it used, over a rough draft in a chat box. It
was taken on the repo's test chat page, not on chatgpt.com, so it shows no
site's branding. One is enough to submit; real-site shots (section 2) can be
added later.

---

## 1. Package

- Build: `python scripts/package_extension.py` → `dist/prompt-memory-4.12.0.zip`.
  `scripts/check_release_zip.py` checks it. Never zip the `extension/` folder
  by hand: it would ship the test harnesses.
- The manifest's `description` is already the new summary on this branch.

## 2. Store listing tab

**Name:** `Prompt Memory`

**Summary** (= manifest `description`, max 132 characters; already set on
this branch; it used to say "Free, with your own API key", but 4.12.0 leads
with Google sign-in) (107 characters):

> Turn a rough draft into a clear prompt in one click, right in ChatGPT, Claude, Gemini, Perplexity and Grok.

**Description** (plain text; the store does not render Markdown):

```
Type a rough draft in ChatGPT, Claude, Gemini, Perplexity or Grok and press the ⊕ button (or Ctrl+Shift+E). Prompt Memory rewrites it into a clearer prompt and shows it on a card beside the chat box, so you can read it before you use it. Replace your draft with it, or keep your own. Nothing is sent to the chat until you press send.

IT KEEPS YOUR MEANING
It rewrites your request rather than answering it, and aims to keep your names, numbers, code and language (Hinglish included) as you gave them. Always read the rewrite before you send it.

TRY ANOTHER STYLE
Shorter, More detail or Open-ended in one click. Every version stays on the card, so going back is free. Compare the rewrite with your original whenever you like.

YOUR SAVED PROMPTS, ONE // AWAY
Save the prompts and details you keep retyping and type // in any chat to drop them in. Saved prompts can also shape a rewrite as context.

SEE WHAT SHAPED A REWRITE
The card names the saved prompts it used, including the ones Prompt Memory found by itself, and lets you rewrite again without any of them.

ALSO
Your rewrite History, voice input (Ctrl+Shift+Space), and a rating on each rewrite so it learns what works for you.

FREE
Sign in with Google for 15 free rewrites a day, your saved prompts and History on every computer. No card needed. Already have a Groq, Gemini or OpenRouter API key? Use it instead, with or without an account.

YOUR DATA
Nothing is sent until you press ⊕, and the first time you are told exactly what is sent. Signed in, your draft and a few recent messages from the chat go to our server and an AI provider, and your drafts and rewrites are kept in your History; you can turn chat context off. With your own key and no account, the draft goes straight from your browser to that provider. Prompt tracking is off unless you turn it on.
Privacy policy: https://prompt-engineering-skeleton-seven.vercel.app/privacy

Prompt Memory is independent and is not affiliated with OpenAI, Anthropic, Google, Perplexity or xAI.
```

No user counts, testimonials or "10x better" claims: reviewers reject
unsupported claims.

**Category:** Productivity → Tools.

**Language:** English.

**Store icon:** `store-icon-128.png`

**Screenshots** (1280×800 or 640×400, PNG/JPEG, up to 5). On the real sites,
with the exact ZIP you upload, at 1280×800 (Chrome DevTools → device toolbar
→ Responsive → 1280 × 800 → ⋮ → Capture screenshot). Harmless sample text
only, never a real conversation:

1. ChatGPT with a rough draft typed and the ⊕ in the corner.
   Sample: `hw do i sort a list of dicts by a key in python, some dont have the key`
2. The card showing the rewrite, with Replace draft and the Shorter / Open-ended buttons.
3. The card's context list open, naming the saved prompts used.
4. Claude or Gemini: `//` typed and the saved-prompt list at the cursor.
5. The toolbar popup's "You're ready. Try it now" screen.

**Small promo tile:** `promo-small-440x280.png`
**Marquee promo tile:** `promo-marquee-1400x560.png` (optional)
**Homepage URL:** `https://prompt-engineering-skeleton-seven.vercel.app/`
**Support URL:** the homepage URL (the support email `hello.promptmemory@gmail.com` is in the site's footer).
**Mature content:** No.

## 3. Privacy practices tab

**Single purpose:**

> Prompt Memory rewrites the draft a user has typed into a supported AI chat's message box into a clearer prompt when they press its button, and lets them save and reuse their own prompts there.

**Permission justifications:**

- `storage`: Keeps the user's settings, their consent, their sign-in session and, if they add one, their own AI provider API key on this device.
- `scripting`: When the extension is installed or updated, adds its button to supported chat tabs that are already open, so the user does not have to reload them.
- Chat sites (`chatgpt.com`, `claude.ai`, `gemini.google.com`, `www.perplexity.ai`, `grok.com`, `x.com/i/grok*`): Places the button on the chat page, reads the text in the message box when the user presses it, writes the rewrite into the box when they choose Replace, and, when signed in, reads the last few messages of the open chat for context.
- `siddhm11-prompt-engine.hf.space`: Prompt Memory's own server: rewrites, Google sign-in, voice transcription, saved prompts and History.
- `api.groq.com`, `generativelanguage.googleapis.com`, `openrouter.ai`: Only when the user adds their own API key for that provider, to send the draft directly to it.

**Remote code:** No. (All JavaScript ships in the package.)

**Data collected** (tick these):

| Category | Tick | Why |
|---|---|---|
| Personally identifiable information | Yes | Email address, from Google sign-in |
| Health / Financial / Location / Web history | No | |
| Authentication information | Yes | Sign-in token; the user's own API key is forwarded with a request when they are also signed in |
| Personal communications | Yes | Recent chat messages sent as context when signed in |
| User activity | Yes | Ratings and feedback; prompts sent to the chat only if Prompt tracking is turned on |
| Website content | Yes | The draft in the message box when the user presses ⊕; voice recordings when they use voice |

**Certify all three:** not sold; not used for unrelated purposes; not used
for creditworthiness or lending.

**Privacy policy URL:** `https://prompt-engineering-skeleton-seven.vercel.app/privacy`

The live page is still the 14 September version. This branch's
`website/privacy.html` (15 October) is the one to publish before you submit:
it adds what the old one left out, which a reviewer could flag:

- usage records (time, style, site, model, latency, whether a rewrite was
  used) and failure records kept 90 days, with no prompt text;
- the automatic quality score (each signed-in rewrite is also sent to an AI
  model to be scored);
- Hugging Face as the host every signed-in prompt passes through;
- up to six recent messages as context, and where its switch is;
- a children's section, and the real names and places of the controls (the
  old page pointed at a "⚙ settings gear in the sidebar" and a "💬 tab").

Deploy the website, then open the URL logged out and check the date says
October 15, 2026.

## 4. Distribution tab

- **Visibility: Unlisted** (link-only; not in search). You can make it Public later.
- **Regions:** All regions. **Pricing:** Free.

## 5. Test instructions (for the reviewer)

Give them a spare Google account; the main path needs sign-in.

```
1. Install. A tab opens explaining what is sent. Choose Agree and continue, then Continue with Google (test account below). Alternatively choose "I have my own API key" and add a Groq key.
2. Open https://chatgpt.com (or claude.ai, gemini.google.com). Type a harmless draft in the message box, for example: explain caching to a beginner. Do not send it.
3. Press the ⊕ button at the bottom corner of the page, or Ctrl+Shift+E. A card shows the rewrite. Choose Replace draft to put it in the message box, or try Shorter / Open-ended. Nothing is sent to the chat site.
4. To delete the test account: toolbar icon → Delete account and data → type DELETE.
Test account: <email> / <password>
```

## 6. After approval

The listing URL is your share link for testers. Later uploads are reviewed
again (usually hours to a few days) and installed copies update themselves.

## Checklist before Submit

- [ ] `store-listing` merged into `main` (the summary, the policy and the logging fix ride with it); version is higher than anything uploaded before.
- [ ] ZIP built with `scripts/package_extension.py`, checked with `scripts/check_release_zip.py`, loaded unpacked from the extracted ZIP in a clean Chrome profile, and tried on ChatGPT, Claude and Gemini.
- [ ] Server deployed from the same `main` (its `/` currently reports 4.1; the logging fix in `backend/routers/prompts.py` only reaches it on deploy).
- [ ] Five real screenshots at 1280×800.
- [ ] Updated privacy policy published; opens logged out and says October 15, 2026.
- [ ] A test Google account for the reviewer.
