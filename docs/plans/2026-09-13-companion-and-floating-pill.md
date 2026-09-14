# Prompt Memory beyond the browser tab: the companion + the pill

Status: **planned, not started.** Written 2026-09-13. Two asks that turned out to be
one product:

1. Make Prompt Memory work *really well* when the user is in a terminal
   (Claude Code, Codex CLI, aider, ssh, plain zsh).
2. Replace the composer-anchored result card with a small, persistent,
   draggable "pill" (Wispr Flow style) that carries the enhanced prompt across
   chat navigation and expands on click.

The unifying idea: **the enhanced prompt becomes a first-class "draft" object
that lives outside any one text box.** In the browser the draft is held by a
floating pill in the page; on the desktop it is held by a floating pill window.
Same draft model, same backend, same keyboard grammar. Build the browser pill
first — it is the cheaper of the two and it forces the draft model into shape
before the desktop app hardens it.

---

## Part 1 — What is wrong today (grounding in the current code)

- The result card (`extension/content.js:1530-1700`) is positioned *relative to
  the composer* and its state (`cardResult`, `cardBasedOn`, `cardState`) is
  in-memory only. Navigate to another chat and the card either points at a
  composer that no longer exists or goes "stale" against empty text. Reload the
  tab and the rewrite is gone. There is no way to enhance in one chat and use
  the result in a fresh one — which is exactly when people want it ("this thread
  is polluted, start clean with the good prompt").
- There are **four** independent floating surfaces: the trigger button
  (`createTrigger`), the result card, the voice overlay (`#pm-voice-overlay`),
  and the toast stack. Plus the side panel. Each has its own positioning code
  and its own collision rules (`positionCard` already has to dodge the panel).
- Nothing exists outside the six matched sites. The product's core value —
  "turn my messy thought into a precise prompt" — is *most* valuable in a
  terminal, where typing a long structured prompt into a TUI is painful and
  there is no browser extension to help.

---

## Part 2 — The draft model (shared by both)

```
Draft {
  id            string      // uuid
  original      string      // what the user typed / said
  enhanced      string      // the rewrite (may be streaming-partial)
  mode          quick|deep|creative|agent
  source        { kind: "site"|"desktop", host: "chatgpt.com"|"terminal"|…, url? }
  language      "en"|"hi"|"hi-Latn"|…
  createdAt     number
  status        streaming|ready|error|applied|discarded
  appliedTo?    { host, url, at }
  logId?        string      // backend log id, for thumbs up/down
}
```

Rules:
- Exactly one **active** draft at a time (the pill shows it). Older drafts go
  to a short in-memory/session history (cap 5, expire after 60 min). Multiple
  simultaneous drafts is a v2 idea; it complicates the pill for little gain.
- The draft **never auto-inserts** into a composer the user didn't invoke it
  on. Surprise text in an input is worse than one extra keystroke. The pill
  *offers*; Enter/Tab accepts.
- Browser persistence: `chrome.storage.session` (survives navigation and tab
  reloads, cleared when the browser closes, extension-wide so a draft made on
  ChatGPT is available on Claude — cross-model routing for free).
- Desktop persistence: in the app's local store; same shape.

---

## Part 3 — The browser pill

### What it is
One component that absorbs the trigger, the result card, and the voice
overlay. Rendered inside a **Shadow DOM** host (`#pm-pill-host`) so host-site
CSS can't leak in and ours can't leak out — the current global `styles.css`
injection is a standing z-index/CSS risk on sites that change their layout.

### States and appearance

| State      | Collapsed pill                                                   | Expanded                                             |
|------------|------------------------------------------------------------------|------------------------------------------------------|
| idle       | 36px round logo button (this *is* the current trigger)           | side panel (unchanged)                               |
| recording  | pill grows to a 160px bar with live waveform + timer, mic red     | —                                                     |
| transcribing | bar with "Transcribing…" shimmer                                | —                                                     |
| streaming  | bar with pulsing dot + first ~40 chars streaming in               | full card, text streaming, same as today             |
| ready      | bar: green dot, 40-char preview, `⏎` hint                         | full card: Insert / Copy / Edit / Redo / Save / Discard |
| stale      | same as ready with an amber dot                                   | card shows "based on earlier text" line, still insertable |
| applied    | shrinks back to idle for 800ms with a ✓, draft goes to history    | —                                                     |
| error      | red dot, one-line reason, `R` to retry                           | card in error state (today's `failStreamingModal`)    |

Design notes:
- **The card anchors to the pill, not the composer.** The pill is the fixed
  point the user learns; the card opens from it (up or down depending on room).
  That removes the "card slides over the composer" class of bugs that
  `positionCard` currently fights.
- **Docked, draggable, remembered.** Default dock: bottom-right, 16px in, above
  the composer's right edge. Drag with pointer events; on release snap to the
  nearest vertical edge; clamp to viewport; persist `{host: {x, y, edge}}` in
  `chrome.storage.local`. Per-host defaults matter: Gemini and Claude both have
  sticky bottom bars that a bottom-right dock would cover.
- **Collision avoidance:** never overlap the composer rect or its send button;
  never overlap the open panel (reuse the `rightBound` logic). If the user
  drags it there anyway, honour it — they chose.
- **Keyboard grammar stays what it is today:** `Ctrl/Cmd+Shift+E` enhances,
  `Ctrl/Cmd+Shift+V` records. Additions: `Ctrl/Cmd+Shift+P` toggles the pill's
  expansion (P for "prompt"); `Esc` collapses; when the pill has a ready draft
  and the composer is *focused and empty*, `Tab` inserts (matches the card's
  existing Tab-to-accept). `aria-live="polite"` on the pill for the status line;
  `aria-expanded` on the toggle.
- **Voice folds in.** Recording state lives in the pill; the separate
  `#pm-voice-overlay` goes away. The review-transcript step becomes the
  expanded pill with the transcript in an editable textarea — the same card,
  different content.
- **Reduced motion:** honour `prefers-reduced-motion`; no waveform animation,
  static level meter instead.

### The navigation moment (the actual feature)
1. Observe SPA navigation: `popstate` + a URL poll every 500ms (the sites use
   `pushState` without events; the Navigation API isn't on all of them yet).
2. On URL change: re-run `findComposer()`; keep the pill exactly where it is;
   re-evaluate staleness against the new composer text.
3. If a ready draft exists and the new composer is **empty**, the pill's
   preview line changes to **"Insert draft here ↵"**. Enter or click inserts.
   If the composer is non-empty, the pill just keeps the preview — inserting
   would clobber what they typed.
4. After insert: `status=applied`, history keeps it for 10 min with a one-click
   "re-insert" from the panel's history tab — covers "I navigated away before
   pressing send".
5. Cross-site: identical logic. A draft made on chatgpt.com shows up in the
   pill on claude.ai. The panel's history tab labels where it came from.

### Implementation phases (browser)
- **B1 — Draft model + persistence.** Extract card state into a `Draft` in
  `chrome.storage.session`; add the navigation observer; make `Ctrl+Shift+E`
  re-open an existing ready draft instead of starting over. No visual change.
  Tests: `tests/test_extension_static.py` style checks + a Playwright smoke that
  navigates between two chat URLs and asserts the draft survives.
- **B2 — Pill component.** Shadow DOM host; absorbs `createTrigger`; card
  re-anchored to pill; drag/snap/persist; per-host defaults. Delete the
  composer-anchored `positionCard`.
- **B3 — Voice into the pill.** Delete `#pm-voice-overlay`; recording,
  transcribing, review all rendered by the pill.
- **B4 — "Insert draft here" + cross-site + history re-insert.**
- **B5 — Polish:** reduced motion, RTL sites, small viewports (Grok on x.com
  narrow column), and a 30-second onboarding hint the first time a draft
  survives a navigation ("Your prompt followed you — press ⏎ to insert").

Risks: host-site z-index changes (Shadow DOM + `position: fixed` + a very
high z-index on the host element mitigates); Gemini's composer is inside a
scroll container and `findComposer` is already fragile there; Perplexity
re-mounts its composer on every route change (re-find on a `MutationObserver`
against `document.body` with a debounce, not just on URL change).

---

## Part 4 — The terminal / desktop companion

### Why the terminal is hard
There is no DOM. The prompt lives in the readline buffer of some other
process (zsh, or Claude Code's own TUI input). macOS Accessibility exposes a
terminal's *screen* (iTerm2: one big `AXTextArea`), not its input buffer.
Reading "what the user has typed so far" out of a terminal is unreliable
across emulators; **writing into it is easy** (paste). Design around that
asymmetry: the companion is the composer; the terminal is the destination.

### Four ways in, in order of leverage

**T1 — `pm` CLI (the primitive; do first).**
`pm "rough thought"`, `pm < file`, `pbpaste | pm | pbcopy`, `pm -v` (record
from the mic until Enter, transcribe, enhance), `pm --mode agent`,
`pm --copy` (result to clipboard, print nothing). Python package in `cli/`,
talks to the existing backend — no new endpoints:
- Auth: the backend's `/auth/google/login` → open URL in system browser →
  poll `/auth/google/poll?state=` is *already* the OAuth-for-native-apps shape
  (RFC 8252 style). Reuse it verbatim. Token in the OS keychain (`keyring`).
- BYOK: `pm config set groq-key …` → keychain; sent as `byok_key` exactly as
  the extension does.
- Streaming: use `/enhance/stream` and print tokens as they arrive; the
  terminal is the one place streaming to stdout is free.
- Send `platform: "terminal"` so analytics can separate this surface.
- Output is the enhanced prompt and nothing else on stdout; status on stderr.
  That's what makes it composable.

**T2 — Shell widgets (cheap, on top of T1).**
A zsh ZLE widget and a bash readline binding: press `Ctrl+E` with text in the
command line → replace the buffer with the enhanced version, cursor at end.
Useful for `claude -p "…"`, `gh issue create --body "…"`, commit messages. It
does *not* reach inside Claude Code's TUI — say so in the docs so nobody
expects it to.

**T3 — Desktop companion app (the real answer; the Wispr Flow model).**
Menu-bar app with a global hotkey and a floating pill window.
- Hotkey anywhere → a small **non-activating** panel appears near the cursor
  (macOS: `NSPanel` with `.nonactivatingPanel` so keyboard focus *stays* in
  the terminal — this one property is the difference between "feels native"
  and "annoying"). Type or dictate the rough thought into it; Enter enhances;
  the result streams in; Enter again **pastes at the cursor** in whatever app
  was frontmost.
- Paste mechanism: save clipboard → write enhanced text → synthesise Cmd+V via
  `CGEvent` → restore clipboard after ~300ms. Requires Accessibility
  permission (one-time prompt; show a friendly explainer, this is where
  Wispr-style apps lose people).
- Two input modes: (a) the pill's own composer (primary — reliable
  everywhere); (b) "grab selection": hotkey with text selected → synthesise
  Cmd+C → read clipboard → enhance → paste over the selection. (b) covers "I
  already typed it in the terminal"; select the line, hit the key.
- **Terminal safety:** pasting multi-line text into a bare shell prompt can
  execute lines. Modern shells have bracketed paste on by default (zsh ≥ 5.1,
  bash ≥ 5.1), and Claude Code / Codex handle multi-line paste correctly. Still:
  default to bracketed-paste escape sequences when the frontmost app is a
  known terminal bundle id (Terminal, iTerm2, WezTerm, Alacritty, kitty,
  Ghostty), and offer a "single-line mode" toggle for people on old bash.
- **Context in the terminal** (the differentiator, stretch): with tmux,
  `tmux capture-pane -p -S -200` gives the last 200 lines of the pane — feed
  that as `conversation_context` so the enhancer can resolve "fix that error"
  the same way it resolves "it" on chatgpt.com. iTerm2's Python API offers the
  same. Opt-in, off by default; the Claude Code transcript can contain secrets.
- **An `agent` mode for the enhancer.** The current templates are tuned for
  chat assistants. Coding-agent prompts want a different shape: goal, the
  files/areas involved, constraints, what "done" looks like, what *not* to
  touch. One new mode in `prompts.py`, selectable from the pill and `pm`.
  This is a backend change worth doing early because it also helps browser
  users of Claude Code's web UI.
- Stack: **Tauri v2.** Rust shell, web UI — which means the pill UI from Part 3
  (Shadow-DOM component, card CSS, `lib/providers.js` for direct BYOK calls)
  is reused nearly as-is. Plugins: `global-shortcut`, `clipboard-manager`,
  `tauri-nspanel` for the non-activating panel. Native Swift would be more
  polished on macOS but forks the UI code and is single-platform. Electron is
  overkill for a 200KB pill.
- History and the side panel become a normal window the menu-bar icon opens.

**T4 — Claude Code hands-free mode (optional, small).**
A `UserPromptSubmit` hook that pipes the prompt through `pm --mode agent
--quiet` and adds the enhanced version as additional context (hooks can add
context; they should not silently replace what the user wrote). Opt-in per
project via `.claude/settings.json`. Useful for people who trust the rewrite
and don't want a review step. Ship after T1; it's ~20 lines.

### Implementation phases (desktop)
- **D0** `agent` mode in the backend (shared with browser).
- **D1** `pm` CLI: auth, BYOK, stream, voice, `--copy`. Homebrew tap + `pipx`.
- **D2** zsh/bash widgets shipped in the CLI package (`pm shell-init zsh`).
- **D3** Tauri companion: hotkey, non-activating pill, composer + voice,
  paste-at-cursor, clipboard restore, terminal bracketed-paste, history window.
- **D4** tmux/iTerm2 context capture (opt-in).
- **D5** Claude Code hook.

### What "works really well in a terminal" means (acceptance)
- Hotkey → speaking → enhanced prompt sitting in Claude Code's input: **< 5 s**
  for a 10-second utterance (Whisper turbo is ~0.3 s; the rest is upload and
  the LLM). Measured, in `evals/`.
- Focus never leaves the terminal. Zero clicks required.
- Never executes anything: bracketed paste on, verified against zsh, bash,
  fish, Claude Code, Codex CLI.
- Works offline-from-our-backend in BYOK direct mode (the Space is on a free
  tier that cold-starts in 30 s; the CLI should not).

---

## Part 5 — Order of work and what to decide

Build order: **B1 → B2 → D0 → D1 → B3 → B4 → D2 → D3 → the rest.** B1/B2
define the draft model and the pill UI that D3 reuses; D0/D1 are small and
unblock terminal users immediately with something composable while the
companion app is built.

Decisions to make before starting (not blocking the plan, blocking the code):
1. Single active draft (recommended) vs. a stack.
2. Default pill dock position per site — needs a quick look at each site's
   bottom bar.
3. Tauri vs. Swift for D3 (recommended Tauri for UI reuse).
4. Whether `agent` mode is a fourth mode or a platform-specific variant of
   `deep` (recommended: a real mode; users will pick it on purpose).
5. Name for the CLI binary — `pm` collides with nothing common on macOS but is
   short enough to be squatted; `promptmem` as fallback.
