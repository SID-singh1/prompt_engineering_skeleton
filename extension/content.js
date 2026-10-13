// extension/content.js — Prompt Memory v4
// One-click prompt engineering. Conversation-aware. Mode-aware. Platform-aware.
// Streaming enhancement. History. Token auto-refresh. Multi-language voice.

// The release extension sends signed-in requests only to our published API.
const DEFAULT_API_URL = "https://siddhm11-prompt-engine.hf.space";  // ← production
// const DEFAULT_API_URL = "http://localhost:8000";  // ← local testing
const API_URL = DEFAULT_API_URL;

// ── Orphaned-script handling ──────────────────────────────────
// Chrome keeps a page's content script running after the extension is
// reloaded or auto-updated, but cuts its chrome.* handle: the next storage
// call throws "Extension context invalidated", as an uncaught rejection, on
// every event that touches storage from then on. That happens to real users
// whenever the Web Store updates the extension under an open chat tab, so
// it is handled, once, in one place: say so, stop the timers, go quiet.
let orphaned = false;
let navigationPoll = null;

function extensionAlive() {
  try { return Boolean(chrome.runtime && chrome.runtime.id); } catch { return false; }
}

function onOrphaned(err) {
  if (orphaned) return;
  if (extensionAlive() && err && !/context invalidated/i.test(String(err.message || err))) return;
  orphaned = true;
  if (navigationPoll) clearInterval(navigationPoll);
  // Chrome cannot revive this isolated world after an extension reload.
  // A single page refresh replaces it with the current content script. Use a
  // persistent notice; a three-second toast disappears before many people
  // return to the tab, and console.warn shows up as an extension error.
  const showReloadNotice = () => {
    if (document.getElementById("pm-reload-notice")) return;
    const notice = document.createElement("div");
    notice.id = "pm-reload-notice";
    notice.className = "pm-reload-notice";
    notice.setAttribute("role", "status");
    const message = document.createElement("span");
    message.textContent = "Prompt Memory updated. Reload this tab to keep using it.";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Reload tab";
    button.addEventListener("click", () => window.location.reload());
    notice.append(message, button);
    document.body.appendChild(notice);
  };
  if (document.body) showReloadNotice();
  else document.addEventListener("DOMContentLoaded", showReloadNotice, { once: true });
}

/** chrome.storage.local.get that cannot throw; an orphaned script gets {}. */
function storageGet(keys, cb) {
  if (orphaned || !extensionAlive()) { onOrphaned(); cb({}); return; }
  try {
    chrome.storage.local.get(keys, (result) => {
      if (!extensionAlive()) { onOrphaned(); cb({}); return; }
      cb(result || {});
    });
  }
  catch (e) { onOrphaned(e); cb({}); }
}

/** chrome.storage.local.set that cannot throw. */
function storageSet(items, cb) {
  if (orphaned || !extensionAlive()) { onOrphaned(); cb?.(false); return; }
  try {
    chrome.storage.local.set(items, () => {
      if (!extensionAlive()) { onOrphaned(); cb?.(false); return; }
      cb?.(!chrome.runtime.lastError);
    });
  } catch (e) { onOrphaned(e); cb?.(false); }
}

console.log("Prompt Memory v4: loaded on", window.location.hostname);

const IS_MAC = navigator.platform?.includes("Mac") || navigator.userAgent?.includes("Mac");
const CMD_KEY = IS_MAC ? "⌘" : "Ctrl+";
// Mac writes chords as glyphs, Windows and Linux spell them out. CMD_KEY
// alone renders "Ctrl+⇧E" off-platform, which is neither convention.
const MOD_SHIFT = IS_MAC ? "⌘⇧" : "Ctrl+Shift+";
// Voice. It was ⌘⇧V / Ctrl+Shift+V, which is "paste as plain text" in Chrome
// and most apps, and "paste and match style" on a Mac: taking it broke paste.
// Space is free in Chrome on every platform and on ChatGPT, Claude and Gemini
// (Gemini has ⌘⇧K, Claude and ChatGPT ⌘⇧O, S, C and ;), and holding it reads
// as push to talk. Chrome lets the user change it at chrome://extensions/shortcuts.
const VOICE_KEY = `${MOD_SHIFT}Space`;
// The same goes for the keys themselves. ↵ and ⇥ are what a Mac keyboard and
// its menus print; on Windows the keycap says Enter and Tab, and "Ctrl+↵" was
// half of each convention.
const ENTER_KEY = IS_MAC ? "↵" : "Enter";
const TAB_KEY = IS_MAC ? "⇥" : "Tab";
const CMD_ENTER = CMD_KEY + ENTER_KEY;

/**
 * Every shortcut this extension answers, grouped by WHERE it works.
 *
 * Grouped by context rather than by feature because the keymap really is
 * context-gated: handleCardKeydown() ignores everything unless focus is in
 * the chat box, the pill or the card, and save/redo/versions only answer
 * inside the card. A flat list would promise keys that do nothing where the
 * reader happens to be standing, which is how a reference loses their trust.
 *
 * This is the one place they are written down, so it has to stay true: if a
 * key moves, it moves here too. tests/test_extension_static.py checks that
 * every chord listed is one the code actually handles.
 */
const SHORTCUTS = () => [
  {
    where: "Anywhere on the page",
    rows: [
      { keys: [`${MOD_SHIFT}E`], what: "Rewrite what is in the chat box" },
      { keys: [VOICE_KEY], what: "Start voice input" },
      { keys: [`${MOD_SHIFT}L`], what: "Open the library" },
      { keys: ["?"], what: "Show this list", note: "when you are not typing" },
    ],
  },
  {
    where: "In the chat box",
    rows: slashEnabled
      ? [
          { keys: ["//"], what: "Open your saved prompts at the cursor" },
          { keys: ["↑", "↓"], what: "Move through them" },
          { keys: [ENTER_KEY], what: "Insert the one you picked" },
          { keys: ["Tab"], what: "Attach it as context instead" },
          { keys: ["Esc"], what: "Close the list" },
        ]
      : [{ keys: ["//"], what: "Saved prompts at the cursor", note: "switched off in Privacy" }],
  },
  {
    where: "When a draft is waiting in the pill",
    rows: [
      { keys: [`${MOD_SHIFT}P`], what: "Show or hide its card" },
      { keys: ["Esc"], what: "Put the card away", note: "stops a rewrite that is still writing" },
    ],
  },
  {
    where: "On the card",
    rows: [
      { keys: [CMD_ENTER], what: "Rewrite it again" },
      { keys: [`${CMD_KEY}S`], what: "Save the rewrite to your library" },
      { keys: ["[", "]"], what: "Step through versions", note: "once there is more than one" },
    ],
  },
  {
    where: "In the library",
    rows: [
      { keys: ["↑", "↓"], what: "Move through the list" },
      { keys: ["→"], what: "Read the whole prompt", note: "← puts it away" },
      { keys: [ENTER_KEY], what: "Add it to context, or take it out", note: "a click does the same" },
      { keys: [CMD_ENTER], what: "Insert it into the chat box" },
      { keys: ["Esc"], what: "Go back, then close" },
    ],
  },
];

// ══════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════

let savedPrompts = [];
let selectedIds = new Set();
let panelOpen = false;
// The three rewrite styles. The default is what ⊕ runs; the card offers the
// other two, since which style a prompt needed is usually only clear once
// you have read a rewrite in the one it got.
const STYLES = ["quick", "deep", "creative"];
const DEFAULT_STYLE = "deep";
let currentMode = DEFAULT_STYLE; // the default style ⊕ runs
const STYLE_NAMES = { quick: "Quick", deep: "Deep", creative: "Creative" };
const STYLE_HINTS = {
  quick: "1\u20133 sentences, just the essentials",
  deep: "structured, with the context and constraints spelled out",
  creative: "open-ended, inviting other angles",
};
// The card names the other two styles by what they would change about the
// version on screen. "Quick" means nothing next to a Quick rewrite you are
// already reading; "Shorter" says what the click will do.
const STYLE_VERBS = {
  deep: { quick: "Shorter", creative: "Open-ended" },
  quick: { deep: "More detail", creative: "Open-ended" },
  creative: { quick: "Shorter", deep: "More focused" },
};
let lastEnhanceResult = null;
let searchQuery = "";
let isRecording = false;
let voiceState = "idle"; // idle | recording | stopping | transcribing | reviewing | enhancing
let enhanceHistory = [];
let usageData = { count: 0, limit: 30 };  // .known once the server has said
// The theme modals and the voice screen are drawn in. The pill, card and
// library are always the console black; this only reaches the overlays.
let uiTheme = "dark";
let isLoadingTab = false;
// Passive prompt tracking: records every prompt the user submits on these
// sites, whether or not they ever press Enhance, and keeps it server-side.
// Off until the user turns it on, as the privacy policy, the first-run notice
// and the popup all say. f8d0b96 had flipped the default to on.
let promptTrackingEnabled = false;

// Conversation context is different in kind: it is read from the page only
// while fulfilling an enhancement the user explicitly asked for, is sent for
// that one request, and is not retained as a profile. It stays on by default
// and is disclosed and toggleable in the panel.
let contextEnabled = true;
let dataConsent = false;

// Load privacy preferences
storageGet(["pm_tracking", "pm_context", "pm_data_consent_v1", "pm_mode"], (result) => {
  promptTrackingEnabled = result.pm_tracking === true;   // default: off
  contextEnabled = result.pm_context !== false;          // default: on
  dataConsent = result.pm_data_consent_v1 === true;
  setDefaultStyle(result.pm_mode, false);
});
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.pm_data_consent_v1) dataConsent = changes.pm_data_consent_v1.newValue === true;
    if (changes.pm_tracking) promptTrackingEnabled = changes.pm_tracking.newValue === true;
    if (changes.pm_context) contextEnabled = changes.pm_context.newValue !== false;
    // Picked in another tab: this one's next ⊕ should agree with it.
    if (changes.pm_mode) setDefaultStyle(changes.pm_mode.newValue, false);
  });
} catch (error) { onOrphaned(error); }

/**
 * Make `style` the one ⊕ runs.
 *
 * Remembered. It used to live only in memory, so every page load quietly put
 * a user who had chosen Quick back on Deep, and the panel went on showing
 * whichever button was pressed last in a tab that no longer existed.
 */
function setDefaultStyle(style, persist = true) {
  currentMode = STYLES.includes(style) ? style : DEFAULT_STYLE;
  syncStylePills();
  if (persist) storageSet({ pm_mode: currentMode });
}

/** Show the default style in the library's ⋯ menu, if it is open. */
function syncStylePills() {
  document.querySelectorAll("#pm-library [data-style]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.style === currentMode));
  });
}

// ══════════════════════════════════════════════════════════════
// AUTH HELPERS (with auto-refresh)
// ══════════════════════════════════════════════════════════════

function getAuth() {
  return new Promise((resolve) => {
    storageGet(["user_id", "token", "email"], (result) => {
      resolve(result && result.token ? result : null);
    });
  });
}

function isTokenExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

function tokenExpiresWithinDays(token, days) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    const expiresAt = payload.exp * 1000;
    const threshold = Date.now() + days * 24 * 60 * 60 * 1000;
    return expiresAt < threshold;
  } catch {
    return true;
  }
}

async function tryRefreshToken(auth) {
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: auth.token }),
    });
    if (res.ok) {
      const data = await res.json();
      storageSet({ token: data.token, email: data.email, user_id: data.user_id });
      console.log("Prompt Memory: token auto-refreshed");
      return data.token;
    }
  } catch (e) {
    console.log("Prompt Memory: token refresh failed", e);
  }
  return null;
}

async function authedFetch(url, options = {}) {
  const { silent = false, ...fetchOptions } = options;
  options = fetchOptions;
  const auth = await getAuth();
  if (!auth) return null;

  // Auto-refresh if token expires within 2 days
  let token = auth.token;
  if (tokenExpiresWithinDays(token, 2) && !isTokenExpired(token)) {
    const newToken = await tryRefreshToken(auth);
    if (newToken) token = newToken;
  }

  if (isTokenExpired(token)) {
    if (!silent) showToast("Session expired — please re-login from the extension popup.", "error");
    return null;
  }

  options.headers = {
    ...options.headers,
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  try {
    const res = await fetch(url, options);
    if (res.status === 401) {
      if (!silent) showToast("Session expired — please re-login from the extension popup.", "error");
      return null;
    }
    return res;
  } catch (err) {
    console.error("Prompt Memory fetch error:", err);
    if (silent) return null;
    if (err.name === "TypeError" && err.message.includes("Failed to fetch")) {
      showToast("Server unavailable — check your connection or try again later.", "error");
    } else {
      showToast("Network error — please try again.", "error");
    }
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// API
// ══════════════════════════════════════════════════════════════

async function fetchSavedPrompts() {
  const res = await authedFetch(`${API_URL}/saved-prompts`);
  if (res && res.ok) {
    const data = await res.json();
    savedPrompts = data.prompts || [];
    promptsLoaded = true;
    reconcileAttachments();
  }
  return savedPrompts;
}

/**
 * Create a saved prompt. Returns "saved" | "duplicate" | "failed".
 *
 * An outcome, not a boolean, and no toast of its own. It used to do both:
 * announce "This prompt is already saved" from in here and then return true, so
 * the caller announced its own success over the top. showToast replaces the
 * toast already on screen, so the accurate message was destroyed by the
 * inaccurate one a frame later — saving the same prompt twice said "Saved to
 * your library" for something that had not been saved. The Save tab said
 * "Prompt saved successfully" for the same non-event.
 *
 * Reporting the outcome and letting each caller phrase it is what makes that
 * unrepresentable: there is no longer a value that means both "fine" and
 * "nothing happened".
 */
let lastSavedPromptId = null;

async function createSavedPrompt(content, title, tags) {
  const body = { content };
  if (title && title.trim()) body.title = title.trim();
  if (tags && tags.length > 0) body.tags = tags;
  const res = await authedFetch(`${API_URL}/saved-prompts`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res || !res.ok) return "failed";
  const data = await res.json();
  lastSavedPromptId = data.id ?? null;   // for Undo; the outcome stays a plain string
  return data.duplicate ? "duplicate" : "saved";
}

async function updateSavedPrompt(id, fields) {
  const res = await authedFetch(`${API_URL}/saved-prompts/${id}`, {
    method: "PUT",
    body: JSON.stringify(fields),
  });
  return res && res.ok;
}

async function deleteSavedPrompt(id) {
  const res = await authedFetch(`${API_URL}/saved-prompts/${id}`, {
    method: "DELETE",
  });
  return res && res.ok;
}

async function enhancePrompt(prompt, selectedPromptIds) {
  const conversation = scrapeConversation();
  const body = {
    prompt,
    platform: window.location.hostname,
    mode: currentMode,
    conversation_context: conversation,
    tracking_enabled: promptTrackingEnabled,
  };
  if (selectedPromptIds && selectedPromptIds.length > 0) {
    body.selected_prompt_ids = selectedPromptIds;
  }
  const res = await authedFetch(`${API_URL}/enhance`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (res && res.ok) return res.json();
  return null;
}

async function enhancePromptStream(prompt, selectedPromptIds, onToken, onDone, inputMetadata = {}, style = currentMode) {
  const auth = await getAuth();
  if (!auth || isTokenExpired(auth.token)) return null;

  const conversation = scrapeConversation();
  const body = {
    prompt,
    platform: window.location.hostname,
    mode: style,
    conversation_context: conversation,
    tracking_enabled: promptTrackingEnabled,
  };
  if (selectedPromptIds && selectedPromptIds.length > 0) {
    body.selected_prompt_ids = selectedPromptIds;
  }
  // Saved prompts the user dropped from the card ("Don't use"): not searched.
  if (inputMetadata.excludedIds && inputMetadata.excludedIds.length) {
    body.excluded_prompt_ids = inputMetadata.excludedIds;
  }
  if (inputMetadata.inputMethod === "voice") {
    body.input_method = "voice";
    if (Number.isFinite(inputMetadata.inputDurationSeconds) && inputMetadata.inputDurationSeconds > 0) {
      body.input_duration_seconds = inputMetadata.inputDurationSeconds;
    }
    if (inputMetadata.sourceLanguage && inputMetadata.sourceLanguage !== "unknown") {
      body.source_language = inputMetadata.sourceLanguage;
    }
  }

  // Attach the user's own key, if they have one, so a signed-in user keeps the
  // memory features while spending their own quota instead of the shared one.
  // It is fetched from the service worker per request and never stored here —
  // this script shares a process with the host page.
  const byok = await askWorker({ type: "PM_GET_BYOK_FOR_BACKEND" });
  if (byok && byok.key) {
    body.byok_provider = byok.provider;
    body.byok_key = byok.key;
    body.byok_model = byok.model;
  }

  const abort = new AbortController();
  cancelActiveStream = () => abort.abort();
  try {
    const res = await fetch(`${API_URL}/enhance/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    });

    if (!res.ok) {
      onDone({ failed: true, detail: `Server returned HTTP ${res.status}.` });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamError = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.token) {
              onToken(data.token);
            } else if (data.done) {
              // Carry any error seen earlier in the stream into the final
              // event, so the caller has one place to check for failure.
              onDone(streamError ? { ...data, failed: true, detail: streamError } : data);
            } else if (data.error) {
              // Was console.error only, which is why a dead model looked
              // identical to a slow one from the user's side.
              streamError = data.detail || data.error;
              console.error("Prompt Memory stream error:", streamError);
            }
          } catch (e) { }
        }
      }
    }
  } catch (e) {
    if (abort.signal.aborted) { onDone({ failed: true, cancelled: true }); return; }
    console.error("Streaming enhance error:", e);
    onDone({ failed: true, detail: "Lost connection to the server mid-response." });
  }
}

async function sendFeedback(logId, rating, original, enhanced) {
  await authedFetch(`${API_URL}/enhance/feedback`, {
    method: "POST",
    body: JSON.stringify({ log_id: logId, rating, original, enhanced }),
  });
}

async function approveEnhancement(logId) {
  // The server resolves the original/refined text from this user's log. Never
  // send editable client text as authority for long-term memory.
  const res = await authedFetch(`${API_URL}/enhance/accept`, {
    method: "POST",
    body: JSON.stringify({ log_id: logId }),
    silent: true,
  });
  return Boolean(res && res.ok);
}

async function trackPrompt(prompt) {
  if (!promptTrackingEnabled || !onTrackableSurface()) return;
  const auth = await getAuth();
  if (!auth || isTokenExpired(auth.token)) return;
  authedFetch(`${API_URL}/track`, {
    method: "POST",
    body: JSON.stringify({
      user_id: auth.user_id,
      prompt,
      platform: window.location.hostname,
    }),
  });
}

async function fetchEnhanceHistory() {
  const res = await authedFetch(`${API_URL}/enhance/history`);
  if (res && res.ok) {
    const data = await res.json();
    enhanceHistory = data.history || [];
  }
  return enhanceHistory;
}

// ══════════════════════════════════════════════════════════════
// CONVERSATION SCRAPING
// Reads the visible chat history from the page DOM
// ══════════════════════════════════════════════════════════════

function scrapeConversation() {
  const messages = [];
  if (!contextEnabled) return messages;  // Respect privacy setting
  const hostname = window.location.hostname;
  // Each site's markings are in sites.js (PM_SITES.conversation).
  const site = PM_SITES.conversation[PM_SITES.conversationAliases[hostname] || hostname];

  try {
    if (site) {
      const taken = [];
      document.querySelectorAll(site.messages).forEach((el) => {
        if (site.nested) {
          if (taken.some((t) => t.contains(el))) return;
          taken.push(el);
        }
        const text = el.innerText?.trim();
        if (text && text.length > 2) {
          messages.push(`[${site.role(el)}]: ${text.substring(0, 500)}`);
        }
      });
    } else {
      const fallback = PM_SITES.conversationFallback;
      document.querySelectorAll(fallback.messages).forEach((el) => {
        const text = el.innerText?.trim();
        if (text && text.length >= fallback.minLength && text.length <= fallback.maxLength) {
          // Genuinely unknown role on an unrecognised site. Tag it explicitly
          // rather than pushing bare text, so the backend can tell the
          // difference between "not a user message" and "role unknown".
          messages.push(`[unknown]: ${text.substring(0, 500)}`);
        }
      });
    }
  } catch (e) {
    console.log("Prompt Memory: conversation scrape failed", e);
  }

  return messages.slice(-6);
}

// ══════════════════════════════════════════════════════════════
// DRAFT — the rewrite as an object that outlives the composer
// ══════════════════════════════════════════════════════════════
//
// The card used to hold its result in a handful of module variables and
// anchor itself to the composer. Switch chats and the composer it was
// anchored to is gone; reload the tab and the rewrite is gone with it. So
// there was no way to enhance in one conversation and use the result in a
// fresh one — which is exactly when people want it ("this thread is
// polluted, start clean with the good prompt").
//
// The draft is the same data, written through to extension storage. Session
// storage is preferred: it survives navigation and reloads, is cleared when
// the browser closes, and is shared across the matched sites — so a draft
// made on chatgpt.com is waiting in the pill on claude.ai. The service worker
// grants content scripts access to it (see background.js); if that grant is
// missing the store falls back to local storage with a hard expiry.

const DRAFT_KEY = "pm_draft";
const DRAFT_TTL_MS = 60 * 60 * 1000;

const draftStore = {
  _area: null,
  // Every operation waits for the one before it. setExpanded() is a read then
  // a write, and closeCard() starts it (through hideCard) a moment before
  // clear(). The read landed, then the clear, then the write put the draft
  // straight back — so every Insert and every Discard reappeared as a draft
  // on the next page load.
  _queue: Promise.resolve(),
  _serial(fn) {
    const run = this._queue.then(fn);
    this._queue = run.catch(() => {});
    return run;
  },
  async area() {
    if (this._area) return this._area;
    try {
      if (chrome.storage.session) {
        await chrome.storage.session.get(DRAFT_KEY);   // throws without the access grant
        this._area = chrome.storage.session;
        return this._area;
      }
    } catch { /* not granted; fall through */ }
    this._area = chrome.storage.local;
    return this._area;
  },
  load() {
    return this._serial(async () => {
      try {
        const area = await this.area();
        const { [DRAFT_KEY]: draft } = await area.get(DRAFT_KEY);
        if (!draft || !draft.result || !draft.result.enhanced) return null;
        if (Date.now() - (draft.createdAt || 0) > DRAFT_TTL_MS) {
          await area.remove(DRAFT_KEY);
          return null;
        }
        return draft;
      } catch {
        return null;
      }
    });
  },
  save(draft) {
    return this._serial(async () => {
      try {
        const area = await this.area();
        await area.set({ [DRAFT_KEY]: draft });
      } catch { /* storage is a convenience; the in-memory card still works */ }
    });
  },
  clear() {
    return this._serial(async () => {
      try {
        const area = await this.area();
        await area.remove(DRAFT_KEY);
      } catch { /* nothing to clear */ }
    });
  },
  /** Record whether the card is open, so a reload brings it back the same way. */
  setExpanded(expanded) {
    return this._serial(async () => {
      try {
        const area = await this.area();
        const { [DRAFT_KEY]: draft } = await area.get(DRAFT_KEY);
        if (draft && draft.expanded !== expanded) await area.set({ [DRAFT_KEY]: { ...draft, expanded } });
      } catch { /* cosmetic */ }
    });
  },
};

// ══════════════════════════════════════════════════════════════
// UI: THE PILL (trigger + draft holder in one)
// ══════════════════════════════════════════════════════════════
//
// The ⊕ button is still the ⊕ button — click enhances, shift-click opens the
// library — but it now also *holds* the current draft. With nothing pending it
// is the same round button it always was. Once a rewrite exists it grows into
// a pill: a status dot, a preview of the rewrite, and a one-click Insert when
// the composer is empty. Click the preview to expand the full card; press Esc
// to tuck it away again. The draft stays in the pill until it is inserted or
// discarded, across chats, reloads and sites.
//
// It is draggable. Position is remembered per host and snapped to the nearest
// side, so it can be moved off anything a site puts in the bottom-right corner
// and stays put. The library button and the card follow it.

const PILL_MARGIN = 16;
const PILL_HOME_BOTTOM = 24;   // home: the bottom corner on the docked side
// The narrowest an open pill gets made to fit beside the chat box: its dot,
// verb and × with a few letters of preview. Narrower than that it steps up.
const PILL_MIN_OPEN_W = 150;
let pillDock = "right";        // "left" | "right" — which side the pill snaps to
let pillBottom = PILL_HOME_BOTTOM; // distance from the viewport bottom, in px
let pillSuppressClick = false; // a drag just ended; swallow the click it fires
let pillSignature = "";        // last rendered state, to skip no-op renders
let pillApplied = null;        // { result, thanked, timer } for the 6s after an insert

// Drawn, not typed. U+2295 and U+00D7 render with whatever font the host page
// falls back to — thin on one machine, off-baseline on the next. A 1.5px
// stroke drawn to the pixel is the same everywhere.
const PILL_GLYPH_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="6.75"/><path d="M8 5v6M5 8h6"/></svg>';
const PILL_X_SVG =
  '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M2 2l8 8M10 2l-8 8"/></svg>';
const CARD_MIN_SVG =
  '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M2.5 6h7"/></svg>';
// The card's quiet actions. Show original is two texts trading places;
// Discard is a bin, not an ×, so it is never mistaken for closing the card.
// The mark for "rewrite again", on the style buttons: the same sparkle as Improve.
const CARD_SPARK_SVG =
  '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
  '<path d="M6.5 3Q7 8.5 12.5 9 7 9.5 6.5 15 6 9.5.5 9 6 8.5 6.5 3Z"/>' +
  '<path d="M12.5 1q.2 2.3 2.5 2.5-2.3.2-2.5 2.5-.2-2.3-2.5-2.5 2.3-.2 2.5-2.5Z" opacity=".75"/></svg>';
const CARD_COMPARE_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/></svg>';
const CARD_DISCARD_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5h11M6.5 4.5V2.8h3v1.7M4 4.5l.7 8.7h6.6l.7-8.7"/></svg>';
const PILL_THUMB_SVG = (down) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${down ? ' style="transform:scale(-1)"' : ""}>` +
  '<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.3a2 2 0 0 0 2-1.7l1.4-9a2 2 0 0 0-2-2.3H14zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>';

function createTrigger() {
  if (document.getElementById("pm-trigger")) return;
  // A div, not a <button>: the pill carries its own buttons (Insert, ×), and
  // a button may not contain buttons. Keyboard access is restored by hand.
  const btn = document.createElement("div");
  btn.id = "pm-trigger";
  btn.className = "pm-trigger";
  btn.setAttribute("role", "button");
  btn.setAttribute("tabindex", "0");
  btn.setAttribute("aria-live", "polite");
  btn.dataset.state = "idle";
  // One verb button, relabelled per state by renderPill(); one × whose
  // meaning (cancel / dismiss / discard) also follows the state.
  btn.innerHTML =
    `<span class="pm-pill-glyph" aria-hidden="true">${PILL_GLYPH_SVG}</span>` +
    // "Improve", beside the ⊕ while the chat box holds a draft (see renderPill).
    `<span class="pm-pill-word" aria-hidden="true">Improve</span>` +
    `<span class="pm-pill-dot" aria-hidden="true"></span>` +
    `<span class="pm-pill-labelwrap"><span class="pm-pill-label"></span></span>` +
    `<button class="pm-pill-insert" type="button" hidden></button>` +
    `<span class="pm-pill-rate" hidden>` +
      `<button class="pm-pill-up" type="button" title="Good rewrite" aria-label="Good rewrite">${PILL_THUMB_SVG(false)}</button>` +
      `<button class="pm-pill-down" type="button" title="Bad rewrite" aria-label="Bad rewrite">${PILL_THUMB_SVG(true)}</button>` +
    `</span>` +
    `<button class="pm-pill-x" type="button" title="Discard this draft" aria-label="Discard draft" hidden>${PILL_X_SVG}</button>` +
    // How many saved prompts the next rewrite will carry: ⊕ is where context
    // is used, so it counts it, as the Library chip does.
    `<span class="pm-pill-ctx" aria-hidden="true" hidden></span>`;
  btn.title = "Enhance this prompt\nShift-click for your library";
  // Click runs the thing people came for. This used to open the panel, which
  // meant the primary action sat two clicks deep behind a tab bar; the library
  // is the secondary path now, not the front door.
  //
  // With a draft pending, handleEnhance() opens that draft instead of spending
  // a model call on the same text — see reopenDraftIfRelevant().
  btn.addEventListener("click", (e) => {
    if (e.shiftKey) togglePanel();
    else if (pillApplied) clearApplied();   // "Inserted" is a receipt, not a button
    else handleEnhance();
  });
  // A drag ends with a click event on the same element. Capture phase, so it
  // never reaches the handler above.
  btn.addEventListener("click", (e) => {
    if (!pillSuppressClick) return;
    pillSuppressClick = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
  btn.addEventListener("keydown", (e) => {
    if (e.target !== btn) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (pillOffersInsert()) insertDraft();
      else handleEnhance();
    }
  });
  btn.querySelector(".pm-pill-insert").addEventListener("click", (e) => {
    e.stopPropagation();
    pillVerb();
  });
  btn.querySelector(".pm-pill-x").addEventListener("click", (e) => {
    e.stopPropagation();
    const was = cardState;
    if (was === "streaming" && cardRerunFrom) { cancelStreaming(); return; }
    closeCard();
    if (was === "streaming") showToast("Rewrite cancelled.", "info");
    else if (was === "ready") showToast("Draft discarded.", "info");
  });
  btn.querySelector(".pm-pill-up").addEventListener("click", (e) => { e.stopPropagation(); ratePill("up"); });
  btn.querySelector(".pm-pill-down").addEventListener("click", (e) => { e.stopPropagation(); ratePill("down"); });
  document.body.appendChild(btn);
  setupPillDrag(btn);
  restorePillPosition();
  renderPill();
  window.addEventListener("resize", () => placePill());
  // The label opens and closes with a transition, so the pill's width — and
  // with it where the library button and the card belong, and whether the
  // pill now reaches the composer — changes frame by frame. Placement follows
  // the size rather than guessing when the transition is done.
  new ResizeObserver(() => placePill()).observe(btn);

  // A visible way into the library.
  //
  // Shift-click still works, and click on ⊕ is still enhance — that ordering
  // was chosen on purpose and this does not relitigate it. But shift-click on a
  // plus sign was the ONLY way in, which made saved-prompt context selection
  // read as a feature that had been removed. It sits next to the trigger and
  // appears on hover or keyboard focus, so it is found through the ordinary use
  // of the button people already click, without parking a second permanent
  // object on every page.
  //
  // Must follow the trigger in the DOM: the reveal is a sibling selector.
  const lib = document.createElement("button");
  lib.id = "pm-library-btn";
  lib.className = "pm-library-btn";
  // Drawn, like ⊕: a typed ☰ rendered in whatever font the host fell back to.
  lib.innerHTML = `${LIB_ICON.shelf}<span>Library</span><span class="pm-library-count" hidden></span>`;
  lib.dataset.pmTip = "Your saved prompts";
  lib.dataset.pmKey = `${MOD_SHIFT}L`;
  lib.setAttribute("aria-haspopup", "dialog");
  lib.setAttribute("aria-expanded", "false");
  lib.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePanel();
  });
  document.body.appendChild(lib);

  // Shown by pointer intent, not by CSS :hover. A sibling :hover lasts only
  // while the pointer is on ⊕ itself, so the gap between ⊕ and the chip was
  // enough to lose it on the way over, and the chip faded out from under the
  // click. An invisible bridge across the gap only ever pointed one way, and
  // the chip is not always on that side: it sits right of the pill when the
  // pill is docked left or has grown wide, and above it when beside would put
  // it on the chat box. Entering either one shows the chip; leaving both
  // hides it after a grace period long enough to cross any gap.
  // Help, stacked above the Library chip in the same reveal.
  //
  // There is a "?" chord for this, and on a chat page it is close to useless:
  // "?" has to stay typable, so it only answers when focus is NOT in a text
  // box — and on ChatGPT the caret is in the composer essentially always. A
  // key you must first click away from the thing you are typing in to press
  // is not a shortcut, it is a puzzle. So the chord stays for pages where it
  // does fire, and this is the way people actually find the list: in the same
  // place, by the same gesture, as the Library they already found here.
  const help = document.createElement("button");
  help.id = "pm-help-btn";
  help.className = "pm-help-btn";
  help.type = "button";
  help.innerHTML = `${LIB_ICON.help}<span>Shortcuts</span>`;
  help.dataset.pmTip = "Keyboard shortcuts";
  help.dataset.pmKey = "?";
  help.setAttribute("aria-haspopup", "dialog");
  help.setAttribute("aria-expanded", "false");
  help.addEventListener("click", (e) => {
    e.stopPropagation();
    openShortcuts();
  });
  document.body.appendChild(help);

  let libRevealTimer = null;
  const revealChip = () => {
    clearTimeout(libRevealTimer);
    if (panelOpen) return;
    lib.classList.add("pm-lib-reveal");
    help.classList.add("pm-lib-reveal");
  };
  const concealChip = () => {
    clearTimeout(libRevealTimer);
    libRevealTimer = setTimeout(() => {
      lib.classList.remove("pm-lib-reveal");
      help.classList.remove("pm-lib-reveal");
    }, 350);
  };
  // Every member of the cluster both shows it and holds it open, so crossing
  // from ⊕ to Library to Shortcuts never passes over a gap that hides it.
  for (const el of [btn, lib, help]) {
    el.addEventListener("pointerenter", revealChip);
    el.addEventListener("pointerleave", concealChip);
  }

  // Apply saved theme to both docked controls
  storageGet("pm_theme", (result) => {
    const theme = result.pm_theme || "dark";
    uiTheme = theme;
    btn.setAttribute("data-pm-theme", theme);
    lib.setAttribute("data-pm-theme", theme);
    help.setAttribute("data-pm-theme", theme);
  });
}

/** Whether the pill's one-click Insert applies right now. */
function pillOffersInsert() {
  return cardState === "ready" && Boolean(cardResult) && !cardStale;
}

/** Insert the draft without opening its review card. */
async function insertDraft() {
  if (!pillOffersInsert()) return;
  cardShowingOriginal = false; // The pill previews the rewrite, never the original.
  await acceptCard();
}

/**
 * The pill's one verb, resolved by state: Insert a ready draft, Redo a stale
 * one, Retry a failed one. Whatever the state, the chip is the way out of it.
 */
function pillVerb() {
  if (pillApplied?.undo) { undoReplace(); return; }
  if (cardState === "ready" && !cardStale) insertDraft();
  else if (cardState === "ready" && cardStale) redoCard();
  else if (cardState === "error") { closeCard(); handleEnhance(); }
}

/** What a ready, fresh draft's one button says: see pillVerb() for what it does. */
function draftVerb() {
  return cardSubject ? "Update" : norm(getCurrentInputText()) ? "Replace" : "Insert";
}

/** Keyboard focus is in the composer the draft would be written into. */
function composerHasFocus() {
  const composer = findComposer();
  const active = document.activeElement;
  return Boolean(composer && active && (composer === active || composer.contains(active)));
}

/**
 * Six seconds of "Inserted", with the rating question inside the pill. This
 * replaces the feedback toast for the accept flow: one event, one object.
 * `result` is null when there is no log_id to rate against, in which case the
 * pill only confirms.
 */
function showApplied(result, undo = null) {
  clearTimeout(pillApplied?.timer);
  pillApplied = { result, undo, thanked: false, timer: setTimeout(clearApplied, undo ? 8000 : 6000) };
  renderPill();
}

/**
 * Undo a Replace: write back exactly what the chat box held, and bring the
 * rewrite back on the card, versions and all, so another version can be
 * picked. Refused if the box has been edited since, because writing over the
 * user's new words is the one thing an Undo must not do.
 */
async function undoReplace() {
  const u = pillApplied?.undo;
  if (!u) return;
  clearApplied();
  if (norm(getCurrentInputText()) !== norm(u.written)) {
    showToast("The chat box has changed since, so Undo would overwrite it.", "error");
    return;
  }
  if (!(await restoreComposer(u.before))) {
    showToast(`Couldn\u2019t put your text back. Press ${CMD_KEY}Z in the chat box.`, "error");
    return;
  }
  if (cardState !== "idle") return;   // a new draft started meanwhile; leave it be
  const d = u.draft;
  cardOriginal = d.original;
  cardBasedOn = d.basedOn;
  cardHasBaseline = true;
  cardVersions = d.versions;
  cardShowingOriginal = false;
  showDiffModal(d.result);
}

/** Put the chat box back to `text`, which may be empty. */
async function restoreComposer(text) {
  if (norm(text)) return applyToInput(text);
  const el = findComposer();
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return applyToInput("");
  await clearComposer(el);
  await nextFrame();
  return !norm(getCurrentInputText());
}

function clearApplied() {
  if (!pillApplied) return;
  clearTimeout(pillApplied.timer);
  pillApplied = null;
  renderPill();
}

function ratePill(rating) {
  const a = pillApplied;
  if (!a || !a.result || a.thanked) return;
  sendFeedback(a.result.log_id, rating, a.result.original, a.result.enhanced);
  cardRatings.set(a.result.log_id, rating);
  clearTimeout(a.timer);
  a.thanked = rating;
  a.timer = setTimeout(clearApplied, 1200);
  renderPill();
}

/**
 * Reflect the draft's state on the pill.
 *
 * Called from every card transition and from the input listener, so it must be
 * cheap and must not touch the DOM when nothing changed — the input listener
 * fires on every keystroke on the host page.
 */
function renderPill() {
  const pill = document.getElementById("pm-trigger");
  if (!pill) return;

  // Every non-idle state carries exactly one verb — the one that resolves it.
  let state = "idle";
  let label = "";
  let verb = "";
  let discard = false;

  if (cardState === "streaming") {
    // The card beside it shows the text arriving; the pill only says that
    // something is happening. Streaming the first 40 characters into a
    // one-line label made a ticker nobody could read.
    state = "streaming";
    label = "Rewriting\u2026";
    discard = true;
  } else if (cardState === "error") {
    state = "error";
    label = cardError || "Enhancement failed";
    verb = "Retry";
    discard = true;
  } else if (cardState === "ready" && cardResult) {
    discard = true;
    label = cardResult.enhanced;
    if (cardStale) {
      state = "stale";
      verb = "Redo";
    } else {
      // The moment this exists for: a fresh chat, an empty box, a draft that
      // followed the user here. The verb says what it will do.
      state = "ready";
      verb = draftVerb();
    }
  } else if (pillApplied) {
    state = "applied";
    const replaced = pillApplied.undo && norm(pillApplied.undo.before);
    label = pillApplied.thanked ? "Thanks" : replaced ? "Replaced" : "Inserted";
    // Undo is the verb while it can still be used.
    if (pillApplied.undo && !pillApplied.thanked) verb = "Undo";
  }

  // Idle with a draft in the chat box, the ⊕ says what it does: "⊕ Improve".
  // Two testers never found a bare ⊕ in the window's corner; a word beside
  // it, appearing as they type, is what the eye catches.
  const invite = state === "idle" && norm(getCurrentInputText()).length >= 3;

  const sig = `${state}|${label.slice(0, 60)}|${verb}|${discard}|${selectedIds.size}|${invite}`;
  if (sig === pillSignature) return;
  pillSignature = sig;

  pill.dataset.state = state;
  pill.classList.toggle("pm-pill-open", state !== "idle");
  pill.classList.toggle("pm-pill-invite", invite);
  const labelEl = pill.querySelector(".pm-pill-label");
  labelEl.textContent = label.replace(/\s+/g, " ").trim().slice(0, 120);

  const verbEl = pill.querySelector(".pm-pill-insert");
  verbEl.hidden = !verb;
  if (verb) {
    verbEl.textContent = verb;
    verbEl.title = {
      Insert: "Insert into the chat box",
      Update: "Update the saved prompt with this rewrite",
      Replace: "Replace the chat box text with the rewrite",
      Redo: "Rewrite what is in the chat box now",
      Retry: "Try the rewrite again",
      Undo: "Put back what was in the chat box",
    }[verb];
  }
  pill.querySelector(".pm-pill-rate").hidden = !(state === "applied" && pillApplied.result && !pillApplied.thanked);
  const xEl = pill.querySelector(".pm-pill-x");
  xEl.hidden = !discard;
  xEl.title = state === "streaming" ? "Cancel the rewrite" : state === "error" ? "Dismiss" : "Discard this draft";
  xEl.setAttribute("aria-label", xEl.title);

  const ctx = selectedIds.size;
  const ctxBadge = pill.querySelector(".pm-pill-ctx");
  if (ctxBadge) { ctxBadge.hidden = !ctx || state !== "idle"; ctxBadge.textContent = String(ctx); }
  const withCtx = ctx ? ` with ${ctx} saved prompt${ctx === 1 ? "" : "s"} as context` : "";
  pill.setAttribute("aria-label", {
    idle: (invite ? "Improve this prompt" : "Enhance this prompt") + withCtx,
    streaming: "Rewriting your prompt",
    ready: "Enhanced prompt ready. Click to review or use Insert.",
    stale: "Enhanced prompt ready, but the chat box has changed since. Redo rewrites the new text.",
    error: "Enhancement failed. Retry runs it again.",
    applied: "Rewrite inserted.",
  }[state]);
  pill.title = state === "idle"
    ? `Enhance this prompt${withCtx}\nShift-click for your library`
    : state === "applied" ? "" : "Click to review the draft \u00b7 drag to move";

  // The pill's width just changed, so everything that hangs off it moves.
  requestAnimationFrame(placePill);
}

// ── Position: docked to a side, remembered per host ──

function pillStorageKey() {
  return `pm_pill_pos:${window.location.hostname}`;
}

function restorePillPosition() {
  storageGet(pillStorageKey(), (r) => {
    const saved = r[pillStorageKey()];
    if (saved && (saved.edge === "left" || saved.edge === "right")) {
      pillDock = saved.edge;
      pillBottom = Number.isFinite(saved.bottom) ? saved.bottom : pillBottom;
    }
    placePill();
  });
}

/**
 * Lay the pill out from (pillDock, pillBottom) and move its dependants.
 *
 * Docked with `left` or `right` rather than absolute coordinates on purpose:
 * the pill grows when a draft arrives, and anchoring to the side it sits
 * against makes it grow *away* from the edge instead of off-screen.
 */
/** The composer's box, memoised for one placePill() pass. */
let _c0cache = null;
function c0(el) {
  if (!_c0cache || _c0cache.el !== el) _c0cache = { el, r: el.getBoundingClientRect() };
  return _c0cache.r;
}

function placePill() {
  const pill = document.getElementById("pm-trigger");
  if (!pill) return;
  requestAnimationFrame(positionTip);
  _c0cache = null;
  const maxBottom = Math.max(PILL_MARGIN, window.innerHeight - pill.offsetHeight - PILL_MARGIN);
  pillBottom = Math.min(Math.max(PILL_MARGIN, pillBottom), maxBottom);

  // One rule for where the pill goes: the user's spot, unless the card or
  // the composer is there — then HOME, the bottom corner on its own side,
  // until the card folds. Home is where the eye already expects the pill, so
  // a pill that has to move goes somewhere known rather than somewhere new.
  // An earlier cut parked it on the card's top corner instead: a third
  // position to learn, and one the card could grow over while streaming.
  //
  // None of this is a move — pillBottom and the dock are untouched, and the
  // pill drops back to its spot the moment the obstacle is gone.
  //
  // Last resort, when home itself is under the composer (the wide composers
  // of the chat views) or under the card that sits on it: step up AND IN to
  // that object's top corner, card last so the pill ends up on top of the
  // stack. Straight up left it hanging in mid-air past the composer's edge.
  let bottom = pillBottom;
  let inset = PILL_MARGIN;
  // A compact pill still must yield to the host composer while the library
  // panel is open. Otherwise it can cover ChatGPT's send button.
  pill.classList.toggle("pm-pill-compact", panelOpen);
  const composer = findComposer();
  // The card is laid out first: on the composer it is independent of the
  // pill, and the pill needs its box to know whether to step aside.
  positionCard();
  if (!panelOpen || composer) {
    // Its whole width, whatever an earlier pass capped it to, so what is
    // decided below follows from the page alone and cannot flap.
    pill.style.maxWidth = "";
    pill.classList.remove("pm-pill-word-off");
    let w = pill.offsetWidth;
    const h = pill.offsetHeight;
    const at = () => ({
      left: pillDock === "left" ? inset : window.innerWidth - inset - w,
      top: window.innerHeight - bottom - h,
    });
    const hits = (r) => {
      if (!r) return false;
      const p = at();
      return p.left < r.right && p.left + w > r.left && p.top < r.bottom && p.top + h > r.top;
    };
    const stepAbove = (r, gap) => {
      bottom = Math.min(maxBottom, Math.round(window.innerHeight - r.top + gap));
      inset = Math.max(PILL_MARGIN, Math.round(pillDock === "left" ? r.left : window.innerWidth - r.right));
    };
    // The box as drawn, as the card and the chips use: measured by its
    // editable, the pill came to rest 11px down over the box's frame.
    const wide = pill.classList.contains("pm-pill-open") || pill.classList.contains("pm-pill-invite");
    const c = composer && wide ? composerFrame(composer) : null;
    const cardEl = document.getElementById("pm-card");
    const cb = cardEl ? cardEl.getBoundingClientRect() : null;
    // Wider than the corner beside the chat box: stay home, made to fit. A
    // draft's preview shortens to the room there (its fade still ends it);
    // "⊕ Improve" drops its word. It used to step up onto the box's corner,
    // and testers saw the pill wander off whenever a draft arrived.
    if (hits(c)) {
      const room = Math.floor(pillDock === "left" ? c.left - 8 - PILL_MARGIN : window.innerWidth - PILL_MARGIN - c.right - 8);
      if (pill.classList.contains("pm-pill-open")) {
        if (room >= PILL_MIN_OPEN_W) { pill.style.maxWidth = room + "px"; w = Math.min(w, room); }
      } else {
        pill.classList.add("pm-pill-word-off");
        w = pill.offsetWidth;
      }
    }
    // Only a pill carrying a draft steps aside; an idle one stays where the
    // user put it, as it always has, its word dropped above if it must.
    const box = pill.classList.contains("pm-pill-open") ? c : null;
    if (hits(box) || hits(cb)) {
      bottom = Math.min(maxBottom, PILL_HOME_BOTTOM);
      inset = PILL_MARGIN;
      if (hits(box)) stepAbove(box, 8);
      if (hits(cb)) stepAbove(cb, 8);
    }
  }

  // A fade on a label that is all there would dim its last letter for
  // nothing; measured here because the label's box is still opening when
  // renderPill() runs.
  const labelEl = pill.querySelector(".pm-pill-label");
  if (labelEl) labelEl.classList.toggle("pm-pill-label-fits", labelEl.scrollWidth <= labelEl.clientWidth + 1);

  // "auto", never "": clearing an inline value only un-shadows the one in the
  // stylesheet, and .pm-trigger carries `right: 16px` there. Docked left that
  // left BOTH offsets live, which stretches an auto-width fixed box across the
  // viewport — the pill became a 420px bar the moment it was dragged left.
  pill.style.top = "auto";
  pill.style.bottom = bottom + "px";
  pill.style.left = pillDock === "left" ? inset + "px" : "auto";
  pill.style.right = pillDock === "right" ? inset + "px" : "auto";
  pill.dataset.dock = pillDock;

  // The library button sits beside the pill, on the side away from the edge —
  // unless an open pill has grown wide enough that "beside" lands on the
  // composer. It is revealed on hover, so that put it on top of the send
  // button of the box the user is typing in. Stacked above the pill instead,
  // and hidden when even that spot would cover the composer.
  const lib = document.getElementById("pm-library-btn");
  if (lib) {
    // The panel itself is the library affordance while open. Hiding the chip
    // also keeps it from sitting on the host's send button after restore.
    lib.hidden = panelOpen;
    if (!panelOpen) {
      const beside = inset + pill.offsetWidth + 8;
      const libLeft = pillDock === "left"
        ? beside
        : window.innerWidth - beside - lib.offsetWidth;
      const libTop = window.innerHeight - bottom - (pill.offsetHeight + lib.offsetHeight) / 2;
      const cb = composer && c0(composer);
      const overlaps = (left, top, w = lib.offsetWidth, h = lib.offsetHeight) =>
        cb && left < cb.right && left + w > cb.left && top < cb.bottom && top + h > cb.top;
      const clearOfComposer = !overlaps(libLeft, libTop);

      lib.dataset.dock = pillDock;
      const libH = lib.offsetHeight;
      const inline = clearOfComposer ? beside : inset;
      lib.style.top = "auto";
      lib.style.bottom = clearOfComposer
        ? (bottom + (pill.offsetHeight - lib.offsetHeight) / 2) + "px"
        : (bottom + pill.offsetHeight + 8) + "px";
      lib.style.left = pillDock === "left" ? inline + "px" : "auto";
      lib.style.right = pillDock === "right" ? inline + "px" : "auto";
      const finalLeft = pillDock === "left" ? inline : window.innerWidth - inline - lib.offsetWidth;
      const finalTop = clearOfComposer ? libTop : window.innerHeight - bottom - pill.offsetHeight - 8 - lib.offsetHeight;
      lib.hidden = Boolean(overlaps(finalLeft, finalTop)) || finalTop < PILL_MARGIN;

      // Shortcuts sits directly on top of Library, sharing its edge offset, so
      // the cluster reads as one column growing upward from ⊕ rather than as
      // chips scattered around it. Above and not below because below is the
      // composer on every one of these sites.
      const hlp = document.getElementById("pm-help-btn");
      if (hlp) {
        // Laid out before it is measured, the way `lib.hidden = panelOpen`
        // above clears Library before Library is measured. hidden is
        // display:none, so a chip that went away once would measure 0x0 and
        // then decide from that phantom box whether it may come back.
        hlp.hidden = false;
        // libH is measured above, before lib.hidden may have zeroed it: a
        // display:none element reports offsetHeight 0, which would stack this
        // chip on the wrong row the moment Library came back.
        const hlpBottom = (parseFloat(lib.style.bottom) || 0) + libH + 8;
        hlp.dataset.dock = pillDock;
        hlp.style.top = "auto";
        hlp.style.bottom = hlpBottom + "px";
        hlp.style.left = pillDock === "left" ? inline + "px" : "auto";
        hlp.style.right = pillDock === "right" ? inline + "px" : "auto";
        const hlpW = hlp.offsetWidth, hlpH = hlp.offsetHeight;
        const hlpLeft = pillDock === "left" ? inline : window.innerWidth - inline - hlpW;
        const hlpTop = window.innerHeight - hlpBottom - hlpH;
        // Hidden with Library, not merely alongside it: if there is no room
        // for the chip this one stands on, a lone "?" floating over the page
        // belongs to nothing.
        hlp.hidden = lib.hidden
          || Boolean(overlaps(hlpLeft, hlpTop, hlpW, hlpH))
          || hlpTop < PILL_MARGIN;
      }
    }
  }
  const hlpOff = document.getElementById("pm-help-btn");
  if (hlpOff && panelOpen) hlpOff.hidden = true;
  positionCard();
  positionToasts();
  positionLibrary();
  positionRail();
}

function setupPillDrag(pill) {
  let start = null;
  let moved = false;

  pill.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".pm-pill-insert, .pm-pill-x")) return;
    const box = pill.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: box.left, top: box.top };
    moved = false;
    pill.setPointerCapture(e.pointerId);
  });

  pill.addEventListener("pointermove", (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    // A click with a shaky hand is not a drag.
    if (!moved && Math.hypot(dx, dy) < 5) return;
    moved = true;
    pill.classList.add("pm-pill-dragging");
    const w = pill.offsetWidth, h = pill.offsetHeight;
    const left = Math.max(PILL_MARGIN, Math.min(start.left + dx, window.innerWidth - w - PILL_MARGIN));
    const top = Math.max(PILL_MARGIN, Math.min(start.top + dy, window.innerHeight - h - PILL_MARGIN));
    pill.style.right = "auto";
    pill.style.bottom = "auto";
    pill.style.left = left + "px";
    pill.style.top = top + "px";
    // The card and library button follow live, not just on release.
    for (const id of ["pm-library-btn", "pm-help-btn"]) {
      const el = document.getElementById(id);
      if (el) el.style.opacity = "0";
    }
    positionCard();
  });

  const end = (e) => {
    if (!start) return;
    try { pill.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    start = null;
    pill.classList.remove("pm-pill-dragging");
    for (const id of ["pm-library-btn", "pm-help-btn"]) {
      const el = document.getElementById(id);
      if (el) el.style.opacity = "";
    }
    if (!moved) return;
    pillSuppressClick = true;

    // Snap to the nearer side; keep the height the user chose.
    const box = pill.getBoundingClientRect();
    pillDock = box.left + box.width / 2 < window.innerWidth / 2 ? "left" : "right";
    pillBottom = Math.round(window.innerHeight - box.bottom);
    placePill();
    storageSet({ [pillStorageKey()]: { edge: pillDock, bottom: pillBottom } });
  };
  pill.addEventListener("pointerup", end);
  pill.addEventListener("pointercancel", end);
}

// ── Navigation: the draft follows the user between chats ──

/**
 * The host sites are single-page apps: switching conversations changes the URL
 * with pushState and remounts the composer, and no event tells us. Poll the
 * URL. On a change, re-find the composer and re-judge the draft against it —
 * a fresh chat with an empty box is where "Insert" lights up.
 */
function watchNavigation() {
  let lastUrl = window.location.href;
  const check = () => {
    if (orphaned || !extensionAlive()) { onOrphaned(); return; }
    if (window.location.href === lastUrl) return;
    lastUrl = window.location.href;
    onNavigated();
  };
  window.addEventListener("popstate", check);
  navigationPoll = setInterval(check, 500);
}

function onNavigated() {
  // Another chat: the library was opened for the one the user left.
  if (panelOpen) togglePanel(false);
  // The new composer mounts a beat after the URL changes; look twice.
  for (const delay of [300, 1200]) {
    setTimeout(() => {
      watchComposer();
      refreshCardStaleness();
      renderPill();
      placePill();
    }, delay);
  }
}

/** Bring a draft back from storage after a reload or a new tab. */
async function restoreDraft() {
  const draft = await draftStore.load();
  if (!draft || cardState !== "idle") return;
  // Drafts saved before versions existed carry a single result.
  const versions = Array.isArray(draft.versions) && draft.versions.every((v) => v?.enhanced)
    && draft.versions.length ? draft.versions : [draft.result];
  cardVersions = versions;
  cardVersionIndex = Math.min(Math.max(0, draft.index | 0), versions.length - 1);
  cardResult = versions[cardVersionIndex];
  lastEnhanceResult = cardResult;
  cardOriginal = cardResult.original || "";
  cardSubject = draft.subject && draft.subject.id ? draft.subject : null;
  cardBasedOn = draft.basedOn || norm(cardOriginal);
  cardHasBaseline = true;
  cardState = "ready";
  cardShowingOriginal = false;
  cardStale = isStaleAgainstComposer();
  // The card comes back the way it was left: open if it was open, tucked into
  // the pill if it was minimized.
  cardMinimized = !draft.expanded;
  if (draft.expanded) showDiffModal(cardResult);
  else renderPill();
  // The host's composer mounts a beat after our init; look again, as
  // onNavigated() does, so an open card lands on it rather than hanging off
  // the pill until the next scroll.
  for (const delay of [300, 1200, 3000]) setTimeout(placePill, delay);
}

// ══════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUT: Ctrl+Shift+E = Instant Enhance
// ══════════════════════════════════════════════════════════════

function setupKeyboardShortcut() {
  // Primary path: Chrome intercepts the chords declared in manifest.json's
  // "commands" block at the browser level, so they never reach this page. The
  // service worker catches them and forwards them here.
  if (orphaned || !extensionAlive()) { onOrphaned(); return; }
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (orphaned || msg?.type !== "PM_COMMAND") return;
      if (msg.command === "enhance-prompt") handleEnhance({ reveal: true });
      if (msg.command === "voice-prompt") toggleVoice();
    });
  } catch (e) { onOrphaned(e); return; }

  // Fallback path: the user may have cleared or rebound the command in
  // chrome://extensions/shortcuts, in which case Chrome does not intercept and
  // the keystroke does arrive here.
  document.addEventListener("keydown", (e) => {
    if (orphaned || !extensionAlive()) { onOrphaned(); return; }
    // Accept Cmd on macOS as well as Ctrl. The manifest advertises
    // Command+Shift+E on Mac, but this listener only ever checked ctrlKey — so
    // the advertised Mac shortcut did nothing here.
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;

    // Compare on e.code, not e.key. With Shift held, e.key is layout-dependent
    // ("E" on US QWERTY, but a different character on many other layouts),
    // whereas e.code names the physical key.
    if (e.code === "KeyE") {
      e.preventDefault();
      handleEnhance({ reveal: true });
    } else if (e.code === "Space") {
      e.preventDefault();
      toggleVoice();
    } else if (e.code === "KeyL") {
      // The library, now that the trigger button runs an enhancement instead
      // of opening the panel.
      e.preventDefault();
      togglePanel();
    }
  });

  // "?" is the convention for "what can I press" — GitHub, Gmail, Linear all
  // use it — and it needs no chord to remember. The whole trick is that on a
  // page whose point is a text box, it must still be able to type a question
  // mark: it only answers when the keystroke is not wanted as a character.
  document.addEventListener("keydown", (e) => {
    if (orphaned || !extensionAlive()) { onOrphaned(); return; }
    if (e.key !== "?" || e.isComposing || e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;   // a chord is not the key
    if (isTypingTarget(document.activeElement)) return;
    if (slash || overlayHasInput()) return;           // something else owns the keyboard
    e.preventDefault();
    e.stopPropagation();
    if (keyMapOpen) closeKeyMap();
    else openShortcuts();
  }, true);
}

/**
 * Whether a keystroke belongs to whatever the user is editing.
 *
 * Covers the host's chat box, this extension's own inputs (the library
 * search, the feedback form), and any other field on the page — a shortcut
 * that eats a character someone was typing is worse than no shortcut.
 */
function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// ══════════════════════════════════════════════════════════════
// UI: THE LIBRARY — a sheet on the pill, // in the chat box, a rail for context
// ══════════════════════════════════════════════════════════════
//
// The library used to be a full-height side panel: its own blue-grey theme
// and a theme toggle, four tabs, a second Enhance button, and a checkbox as
// the only thing a saved prompt could do. A saved prompt could not be put
// into the chat box at all, and prompts ticked as context went on shaping
// every rewrite, invisibly, after the panel closed.
//
// It is now three small things in the pill's black:
//   - a sheet that opens above the pill (the Library chip, ⇧-click on ⊕, or
//     ⌘⇧L): search first, one list with Saved | Recent, Insert as the verb,
//     attach as context on ⌘↵, everything else under ⋯;
//   - a menu at the caret when the user types // in the chat box, which
//     inserts right where they are, even mid-sentence;
//   - a rail of chips on the chat box naming the prompts attached as context,
//     so what shapes the next rewrite is visible on the thing being sent.
//
// All three read the same list and use the same keys: ↵ inserts, ⌘↵ (⇥ in
// the chat box) attaches, esc closes.

const LIB_ICON = {
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  more: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  clip: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 5.5 6 10a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4L4 8a4.2 4.2 0 0 0 6 6l3.5-3.5"/></svg>',
  back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>',
  shelf: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="4" rx="1.2"/><path d="M3.5 9.5h9M4.5 12.5h7"/></svg>',
  // Drawn rather than typed, like the others: a "?" left to the host's font
  // renders at a different weight and baseline on every site.
  close: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  tick: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 6.3 5 8.6l4.4-5"/></svg>',
  help: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6a2 2 0 1 1 2.6 1.9c-.5.2-.8.7-.8 1.2v.4"/><circle cx="7.8" cy="11.8" r="0.85" fill="currentColor" stroke="none"/></svg>',
  // Two columns of dots: the thing a window is dragged by.
  grip: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="6" cy="4" r="1.15"/><circle cx="10" cy="4" r="1.15"/><circle cx="6" cy="8" r="1.15"/><circle cx="10" cy="8" r="1.15"/><circle cx="6" cy="12" r="1.15"/><circle cx="10" cy="12" r="1.15"/></svg>',
};

// "recent" is the History tab: every rewrite, as the popup and the consent
// notice call it. "Recent" read as "recently saved", the same thing as Saved.
let libView = "saved";        // "saved" | "recent" (shown as History)
let libPage = "list";         // "list" | "privacy" | "feedback" | "signin" | "edit"
// The New / Edit prompt page: what is typed there, kept as it is typed so a
// redraw of the sheet (a list arriving, a save going out) never loses it.
let libEdit = null;           // { id, original, content, title, tags: Set, tagText, busy, status, error }
let libSel = 0;               // the highlighted row
let libMenu = false;          // the ⋯ menu is open
let libRowMenu = null;        // a row whose ⋯ (Edit, Delete, …) is open
let libFoldedCard = null;     // the card the sheet folded away on opening: { box }
let libConfirm = null;        // a saved prompt awaiting "Delete?"
let libSignedIn = false;      // kept current from storage; // needs it synchronously
let libHistoryLoaded = false;
let slashEnabled = true;      // "Type // for saved prompts", in ⋯
let promptsLoaded = false;
// Titles of attached prompts, so the rail can name them on a page where the
// library has not been opened yet.
const attachTitles = new Map();

// ── Words on a row ──

function promptHeadLength(t) {
  const m = t.match(/^.{0,60}?[.:!?](\s|$)/);
  return m ? m[0].length : Math.min(48, t.length);
}

/** An untitled prompt is named by its first sentence, which the preview then skips. */
function promptTitle(p) {
  const text = norm(p.content);
  return p.title || text.slice(0, promptHeadLength(text)).trim().replace(/[.:]$/, "");
}

function promptPreview(p) {
  const text = norm(p.content);
  return p.title ? text : text.slice(promptHeadLength(text)).trim() || text;
}

/**
 * What a saved row says under its words: its tags, then how old it is.
 * Nothing when there is neither, so a bare prompt is not given an empty line.
 */
function promptMetaHtml(p) {
  const tags = (p.tags || []).slice(0, 3).map((t) => `<span class="pm-lib-tag">#${escHtml(t)}</span>`);
  const age = p.created_at ? `<span>${escHtml(getTimeAgo(p.created_at))}</span>` : "";
  return tags.length || age ? `<div class="pm-lib-meta">${tags.join("")}${age}</div>` : "";
}

// ── The sheet ──

function createLibrary() {
  if (document.getElementById("pm-library")) return;
  const lib = document.createElement("div");
  lib.id = "pm-library";
  lib.className = "pm-lib";
  lib.setAttribute("role", "dialog");
  lib.setAttribute("aria-label", "Library");
  lib.hidden = true;
  // Focusable itself, so its keys still answer on a page with no search box.
  lib.tabIndex = -1;
  document.body.appendChild(lib);

  lib.addEventListener("click", onLibraryClick);
  // After the click has done its work, in the sheet or the preview beside
  // it: see keepSheetKeyboard(). By the path the click took, not its target:
  // the redraw it caused has usually removed the row or button it landed on.
  document.addEventListener("click", (e) => {
    if (!panelOpen || !keyboardFell()) return;
    if (e.composedPath().some((el) => el.id === "pm-library" || el.id === "pm-peek")) keepSheetKeyboard();
  });
  // Words selected in the preview leave the keyboard where it fell (see
  // keepSheetKeyboard): the sheet's keys still answer from there.
  document.addEventListener("keydown", (e) => {
    if (!panelOpen || keyMapOpen || sheetCoveredByForm() || !keyboardFell() || !SHEET_KEYS.has(e.key)) return;
    // A sheet key means the copying is done: the keyboard goes home first.
    const q = libPage === "list" && document.getElementById("pm-lib-q");
    const target = q || document.getElementById("pm-library");
    target?.focus({ preventScroll: true });
    onLibraryKeydown({
      key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, isComposing: false, target,
      preventDefault: () => e.preventDefault(), stopPropagation: () => e.stopPropagation(),
    });
  });
  lib.addEventListener("input", onLibraryInput);
  lib.addEventListener("change", onLibraryChange);
  lib.addEventListener("keydown", onLibraryKeydown);
  lib.addEventListener("pointerdown", startSheetResize);
  lib.addEventListener("pointerdown", startSheetMove);
  lib.addEventListener("mousemove", (e) => {
    const row = e.target.closest?.(".pm-lib-row[data-i]");
    if (!row || Number(row.dataset.i) === libSel) return;
    libSel = Number(row.dataset.i);
    lib.querySelectorAll(".pm-lib-row[data-i]").forEach((r) => r.classList.toggle("pm-sel", Number(r.dataset.i) === libSel));
    syncActiveDescendant();
  });
  lib.addEventListener("pointerover", (e) => {
    const row = e.target.closest?.(".pm-lib-row[data-i]");
    if (!row) return;
    // Only a row that hides some of its words has anything to show beside it.
    // A one-line prompt opened a panel repeating that one line (seen live).
    if (rowIsClipped(row)) schedulePeek(Number(row.dataset.i));
    else { clearTimeout(peekOpenTimer); if (libPeek !== null) hidePeek(); }
  });
  document.addEventListener("pointermove", trackPeekPointer, { capture: true, passive: true });

  // Anywhere else closes it. Capture phase, so a host handler that stops the
  // event cannot strand the sheet open. Modals and toasts the sheet itself
  // raised (edit, delete, consent) do not count as "elsewhere".
  document.addEventListener("pointerdown", (e) => {
    if (!panelOpen) return;
    if (e.target.closest?.("#pm-library, #pm-peek, #pm-save, #pm-keys, #pm-library-btn, #pm-help-btn, #pm-trigger, #pm-rail, .pm-modal-overlay, #pm-toast-stack")) return;
    togglePanel(false);
  }, true);
  // So does scrolling the page: the user has gone back to the conversation.
  // Wheel, not scroll, because only a wheel is the user; a scroll event also
  // comes from the host's own auto-scroll as an answer streams in.
  //
  // Except a wheel turned over the sheet or its preview, which was ignored:
  // over the head, the foot or a list too short to scroll nothing took the
  // turn, and the sheet is not inside the host's scroller, so nothing moved
  // at all: "scroll should close it, but it doesn't". A deliberate turn the
  // sheet cannot use now closes it, as one over the page does. One that
  // scrolls the list or the preview is the sheet's, to its end and through
  // the coast after (see sheetTakesWheel), and a graze of a trackpad is not
  // a turn.
  document.addEventListener("wheel", (e) => {
    if (!panelOpen) return;
    if (e.target.closest?.("#pm-save, #pm-keys, .pm-modal-overlay, #pm-toast-stack")) return;
    if (e.target.closest?.("#pm-library, #pm-peek")) {
      if (sheetTakesWheel(e)) return;
      sheetWheel.sum += Math.abs(e.deltaX) + Math.abs(e.deltaY);
      if (sheetWheel.sum < SHEET_WHEEL_CLOSES) return;
    }
    togglePanel(false);
  }, { capture: true, passive: true });
  // The other ways attention leaves the sheet for the page.
  document.addEventListener("keydown", (e) => {
    if (!panelOpen || !PAGE_SCROLL_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t.closest?.("#pm-library, #pm-peek, #pm-save, #pm-keys, .pm-modal-overlay") || isTypingTarget(t)) return;
    // Arrows from <body> are the sheet's (see keepSheetKeyboard); PageDown,
    // Home, End and Space from there scroll the conversation.
    if (keyboardFell() && SHEET_KEYS.has(e.key)) return;
    togglePanel(false);
  }, true);
  document.addEventListener("focusin", (e) => {
    if (!panelOpen) return;
    const t = e.target;
    // The chat box is the host's to focus, and does so on its own; typing in
    // it is what closes the sheet (see watchComposer). Tab to anything else
    // on the page, and the sheet goes.
    if (t === window || t === document.body || t.closest?.("#pm-library, #pm-peek, #pm-save, #pm-keys, #pm-trigger, #pm-library-btn, #pm-help-btn, #pm-rail, .pm-modal-overlay, #pm-toast-stack")) return;
    if (t === findComposer() || findComposer()?.contains(t)) return;
    togglePanel(false);
  });
  // Another tab: the user went somewhere else entirely.
  document.addEventListener("visibilitychange", () => { if (document.hidden && panelOpen) togglePanel(false); });

  storageGet(["pm_slash", SHEET_SIZE_KEY, sheetPosKey()], (r) => {
    slashEnabled = r.pm_slash !== false;
    const size = r[SHEET_SIZE_KEY] || {};
    sheetSize = { w: Number(size.w) || 0, h: Number(size.h) || 0 };
    const pos = r[sheetPosKey()];
    sheetPos = pos && (Number.isFinite(pos.dx) || Number.isFinite(pos.x)) ? pos : null;
  });
}

function togglePanel(force) {
  hideTip();
  const lib = document.getElementById("pm-library");
  if (!lib) return;
  const open = force !== undefined ? Boolean(force) : !panelOpen;
  if (open === panelOpen) {
    if (open) focusLibrarySearch();
    return;
  }
  panelOpen = open;
  lib.hidden = !open;
  hidePeek();
  const chip = document.getElementById("pm-library-btn");
  chip?.setAttribute("aria-expanded", String(open));
  syncHelpChipExpanded();
  if (open) {
    chip?.classList.remove("pm-lib-reveal");
    document.getElementById("pm-help-btn")?.classList.remove("pm-lib-reveal");
  }
  if (open) {
    closeSlash();
    // The card and the sheet are two windows with one place to be: over the
    // chat box's right half. Opened over a rewrite, the sheet covered the
    // card's end (most of it in a 1024px window). The card folds into the
    // pill, which still carries the draft and its verb, and comes back when
    // the sheet closes, if the chat box is as it was.
    if (cardExpanded && cardState !== "idle") {
      libFoldedCard = { box: norm(getCurrentInputText()) };
      hideCard();
    }
    libPage = "list";
    libEdit = null;
    libView = "saved";
    searchQuery = "";
    libSel = 0;
    libMenu = false;
    libRowMenu = null;
    libConfirm = null;
    libHistoryLoaded = false;   // Recent is refetched per opening: new rewrites belong in it
    renderLibrary();
    focusLibrarySearch();
    loadLibrary();
  } else {
    lib.innerHTML = "";
    // Back, unless something moved on from it meanwhile: the draft was used
    // or thrown away, or a saved prompt went into the chat box, which would
    // bring the card back stale.
    const folded = libFoldedCard;
    libFoldedCard = null;
    if (folded && !cardExpanded && cardState !== "idle" && norm(getCurrentInputText()) === folded.box) expandCard();
  }
  // The pill folds to ⊕ while the sheet is up, and the sheet hangs off it.
  placePill();
  positionRail();
}

/** The chip, "?" and the ⋯ menu all come here: the keyboard map. See openKeyMap(). */
function openShortcuts() {
  hideTip();
  openKeyMap();
}

const SHEET_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape"]);
const PAGE_SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", " ", "ArrowUp", "ArrowDown"]);
// One turn of the wheel arrives as a train of events, then the coast after
// it; the first decides for the rest (see sheetTakesWheel).
let sheetWheel = { at: -Infinity, takes: false, sum: 0 };
const SHEET_WHEEL_CLOSES = 40;   // px of a turn over the sheet, with nothing in it to scroll, that closes it

/**
 * Does something in the sheet (or its preview) scroll with this wheel event?
 * Walks out from the pointer: the first box with room to scroll that way
 * takes it, and one at its end that keeps its scroll to itself
 * (overscroll-behavior: contain, as the list does) swallows it. Decided at
 * the start of a gesture and kept for its events, so a list flung to its
 * end does not close the sheet as it coasts.
 */
function sheetTakesWheel(e) {
  if (e.timeStamp - sheetWheel.at < 160) { sheetWheel.at = e.timeStamp; return sheetWheel.takes; }
  const across = Math.abs(e.deltaX) > Math.abs(e.deltaY);
  const d = across ? e.deltaX : e.deltaY;
  let takes = false;
  for (let el = e.target; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const scrolls = /(auto|scroll)/.test(across ? cs.overflowX : cs.overflowY);
    const size = across ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    if (scrolls && size > 1) {
      const pos = across ? el.scrollLeft : el.scrollTop;
      if (d > 0 ? pos < size - 1 : pos > 0) { takes = true; break; }
      if ((across ? cs.overscrollBehaviorX : cs.overscrollBehaviorY) !== "auto") { takes = true; break; }
    }
    if (el.id === "pm-library" || el.id === "pm-peek") break;
  }
  sheetWheel = { at: e.timeStamp, takes, sum: 0 };
  return takes;
}

/**
 * Nothing in the sheet that can use the keys holds the keyboard: it fell to
 * <body>, or with a node a redraw removed, or a press on the sheet's own
 * ground focused the sheet, which hears esc but cannot move the list.
 */
function keyboardFell() {
  const a = document.activeElement;
  return !a || a === document.body || !a.isConnected || a.id === "pm-library";
}

/** The edit window or the save form is up over the sheet: the keys are theirs. */
function sheetCoveredByForm() {
  return Boolean(document.querySelector("#pm-modal-overlay.pm-visible, #pm-save"));
}

/**
 * A click on a row, on its ⋯, or in the preview left the keyboard on <body>:
 * rows and words do not take focus, and the redraw after a button removes
 * the button that had it. Every key the sheet answers went with it, so ↑↓,
 * ↵, → and esc did nothing until the user clicked the search box again.
 * The keyboard goes back to the sheet, unless the click selected words to copy.
 */
function keepSheetKeyboard() {
  if (sheetCoveredByForm() || String(window.getSelection?.() || "")) return;
  const q = libPage === "list" && document.getElementById("pm-lib-q");
  (q || document.getElementById("pm-library"))?.focus({ preventScroll: true });
}

/** Close the sheet and hand the keyboard back to the chat box. */
function closeLibrary() {
  togglePanel(false);
  findComposer()?.focus({ preventScroll: true });
}

async function loadLibrary() {
  const auth = await getAuth();
  libSignedIn = Boolean(auth && !isTokenExpired(auth.token));
  if (!panelOpen) return;
  if (!libSignedIn) {
    libPage = "signin";
    renderLibrary();
    return;
  }
  if (!(await ensureDataConsent())) { togglePanel(false); return; }
  isLoadingTab = !promptsLoaded;
  renderLibrary();
  await fetchSavedPrompts();
  isLoadingTab = false;
  if (panelOpen) renderLibrary();
  fetchUsage();
}

function focusLibrarySearch() {
  const q = document.getElementById("pm-lib-q");
  if (q && document.activeElement !== q) q.focus({ preventScroll: true });
}

const LIB_ROOM_WANTED = 420;   // px above the chat box before the sheet may come down over its text
const LIB_HEIGHT = 520;        // the sheet's height when there is room for it
const LIB_ROOM_USEFUL = 320;   // px above the chat box that is enough to open there
// The usual width: room for the grip, the search box and its placeholder,
// Saved | History, +, ⋯ and ×. 368 fitted them before the grip.
const SHEET_W = 384;
const SHEET_W_MIN = 300, SHEET_H_MIN = 240;   // the smallest a drag on its edges makes it
// The size the user dragged the sheet to, kept on this device; 0 is "the usual".
const SHEET_SIZE_KEY = "pm_sheet_size";
let sheetSize = { w: 0, h: 0 };
// Where the user dragged the sheet, per site, kept on this device; null is
// "on the chat box". Measured from the chat box (its right edge and top) so it
// follows the box from page to page and window size to window size, or from
// the window when the page has no chat box.
const sheetPosKey = () => `pm_sheet_pos:${window.location.hostname}`;
let sheetPos = null;
let sheetMoveTap = 0;          // when the grip was last pressed without a drag
let sheetGripTap = 0;          // when an edge was last pressed without a drag
// The edges that size it: the one facing away from the pill (its width), the
// one away from the chat box (its height), and the corner between them. The
// sides they sit on follow where the sheet hangs (data-dock, data-side).
const SHEET_GRIPS = ["w", "h", "c"].map((g) =>
  `<div class="pm-lib-grip pm-lib-grip-${g}" data-grip="${g}" title="Drag to resize. Double-click for the usual size." aria-hidden="true"></div>`).join("");

/**
 * Drag an edge of the sheet to size it; kept on this device and used every
 * time it opens, within the window and the room it has. Its corner on the
 * pill stays put, so the far edges are the ones that move.
 */
function startSheetResize(e) {
  const grip = e.target.closest?.(".pm-lib-grip");
  const lib = document.getElementById("pm-library");
  if (!grip || !lib || e.button !== 0) return;
  e.preventDefault();
  const g = grip.dataset.grip;
  const r = lib.getBoundingClientRect();
  const x0 = e.clientX, y0 = e.clientY;
  const towardLeft = lib.dataset.dock === "right";   // its free side is its left
  const upward = lib.dataset.side !== "below";       // its free edge is its top
  // The sheet, not the grip: a redraw mid-drag replaces the grip.
  try { lib.setPointerCapture(e.pointerId); } catch { /* window listeners finish it */ }
  lib.classList.add("pm-lib-resizing");
  let moved = false;
  const move = (m) => {
    if (m.pointerId !== e.pointerId) return;
    const dx = m.clientX - x0, dy = m.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    if (g !== "h") sheetSize.w = Math.round(r.width + (towardLeft ? -dx : dx));
    if (g !== "w") sheetSize.h = Math.round(r.height + (upward ? -dy : dy));
    positionLibrary();
  };
  const end = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    lib.removeEventListener("lostpointercapture", end);
    lib.classList.remove("pm-lib-resizing");
    // Two presses on an edge without a drag put back the usual size. Counted
    // here: with the pointer captured, the dblclick lands on the sheet, not
    // the edge, as it did on the card's grip.
    if (!moved) {
      const again = Date.now() - sheetGripTap < 450;
      sheetGripTap = again ? 0 : Date.now();
      if (again) { sheetSize = { w: 0, h: 0 }; storageSet({ [SHEET_SIZE_KEY]: sheetSize }); positionLibrary(); }
      return;
    }
    // Keep the size it reached, not one the window or the room cut short.
    const b = lib.getBoundingClientRect();
    if (g !== "h") sheetSize.w = Math.round(b.width);
    if (g !== "w") sheetSize.h = Math.round(b.height);
    storageSet({ [SHEET_SIZE_KEY]: sheetSize });
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  lib.addEventListener("lostpointercapture", end);
}
/**
 * Drag the grip in the sheet's head to put it anywhere. Kept per site and used
 * every time it opens (see sheetPos). Two presses on the grip without a drag,
 * or the ↙ in the head, put it back on the chat box.
 */
function startSheetMove(e) {
  const grip = e.target.closest?.(".pm-lib-move");
  const lib = document.getElementById("pm-library");
  if (!grip || !lib || e.button !== 0) return;
  e.preventDefault();
  // Its laid-out place, not getBoundingClientRect(): grabbed while it is still
  // opening, the open animation's scale put the start some pixels off.
  const r = { left: lib.offsetLeft, top: lib.offsetTop, width: lib.offsetWidth };
  const x0 = e.clientX, y0 = e.clientY;
  try { lib.setPointerCapture(e.pointerId); } catch { /* window listeners finish it */ }
  lib.classList.add("pm-lib-moving");
  let moved = false;
  const move = (m) => {
    if (m.pointerId !== e.pointerId) return;
    const dx = m.clientX - x0, dy = m.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    placeSheetFree(lib, r.left + dx, r.top + dy, r.width);
  };
  const end = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
    lib.removeEventListener("lostpointercapture", end);
    lib.classList.remove("pm-lib-moving");
    if (!moved) {
      const again = Date.now() - sheetMoveTap < 450;
      sheetMoveTap = again ? 0 : Date.now();
      if (again) resetSheetPosition();
      return;
    }
    const b = { left: lib.offsetLeft, top: lib.offsetTop };
    const f = composerFrame(findComposer());
    sheetPos = f && f.width >= 240
      ? { dx: Math.round(b.left - f.right), dy: Math.round(b.top - f.top) }
      : { x: Math.round(b.left), y: Math.round(b.top) };
    storageSet({ [sheetPosKey()]: sheetPos });
    renderLibrary();   // the head gains its ↙
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  lib.addEventListener("lostpointercapture", end);
}

/** Back on the chat box, where it opens by default. */
function resetSheetPosition() {
  sheetPos = null;
  storageSet({ [sheetPosKey()]: null });
  if (panelOpen) { renderLibrary(); focusLibrarySearch(); }
}

/**
 * The sheet at a place the user chose, kept whole inside the window. Its top
 * left corner is the one pinned, so a later resize moves its right and bottom
 * edges (data-dock left, data-side below).
 */
function placeSheetFree(lib, x, y, width) {
  const vw = window.innerWidth, vh = window.innerHeight, m = 12;
  const left = Math.round(Math.max(m, Math.min(x, vw - width - m)));
  const top = Math.round(Math.max(m, Math.min(y, vh - SHEET_H_MIN - m)));
  lib.dataset.dock = "left";
  lib.dataset.side = "below";
  lib.style.left = left + "px";
  lib.style.right = "auto";
  lib.style.top = top + "px";
  lib.style.bottom = "auto";
  const room = vh - top - m;
  if (sheetSize.h) {
    const h = Math.round(Math.min(room, Math.max(SHEET_H_MIN, sheetSize.h)));
    lib.style.height = h + "px";
    lib.style.maxHeight = h + "px";
  } else {
    lib.style.height = "";
    lib.style.maxHeight = Math.round(Math.min(room, LIB_HEIGHT)) + "px";
  }
}

const RAIL_GAP = 6, RAIL_ROW = 26;      // the chips' row: its gap above the box, and its height
const RAIL_SLOT = RAIL_GAP + RAIL_ROW;

/**
 * Where the sheet goes: on the chat box it works on, directly above it and
 * lined up with its right edge, the side the pill and the Library chip are
 * on. It used to hang off the pill, which sits in the window's corner, so on
 * a chat box centred in the page (a new chat) the sheet came out in the
 * top-right corner, nowhere near the box. Below the box only when there is
 * more room there. With no chat box on the page it hangs off the pill.
 */
function positionLibrary() {
  const lib = document.getElementById("pm-library");
  const pill = document.getElementById("pm-trigger");
  if (!lib || lib.hidden || !pill) return;
  const vw = window.innerWidth, vh = window.innerHeight, m = 12, gap = 10;
  // A size the user dragged the sheet to wins, within the window and the
  // room it has (see startSheetResize).
  const width = Math.round(Math.min(sheetSize.w ? Math.max(SHEET_W_MIN, sheetSize.w) : SHEET_W, vw - 2 * m));
  lib.style.width = width + "px";
  const composer = findComposer();
  const frame = composerFrame(composer);
  const box = frame && frame.width >= 240 ? frame : null;

  // Moved by hand: where it was put, measured from the chat box when there
  // is one (see startSheetMove).
  const free = sheetPos && (box && Number.isFinite(sheetPos.dx)
    ? { x: box.right + sheetPos.dx, y: box.top + sheetPos.dy }
    : Number.isFinite(sheetPos.x) ? { x: sheetPos.x, y: sheetPos.y } : null);
  lib.classList.toggle("pm-lib-free", Boolean(free));
  if (free) {
    placeSheetFree(lib, free.x, free.y, width);
    positionPeek();
    return;
  }

  let left, ceiling, floor;
  if (box) {
    left = Math.max(m, Math.min(box.right - width, vw - width - m));
    // Above the box it stands on the row the context chips land on, whether
    // or not any have yet. Standing on the chips themselves, the chip that
    // first reached under it, and each that wrapped them onto another row,
    // pushed the sheet up: picking a prompt moved the list being picked
    // from. While the sheet is open the chips keep to that one row (see
    // fitRailToOneRow).
    ceiling = box.top - RAIL_SLOT;
    floor = box.bottom;
    // A tall chat box (a long draft) can leave too little room above it. The
    // sheet may then come down over the box's text, but never over its row
    // of buttons, where Send is.
    if (ceiling - gap - m < LIB_ROOM_WANTED) {
      const controls = composerControlsTop(composer);
      if (controls !== null) ceiling = Math.max(ceiling, Math.min(controls, ceiling + LIB_ROOM_WANTED));
    }
  } else {
    const p = pill.getBoundingClientRect();
    const onRight = p.left + p.width / 2 > vw / 2;
    left = onRight ? Math.max(m, Math.min(p.right - width, vw - width - m)) : Math.max(m, Math.min(p.left, vw - width - m));
    ceiling = p.top;
    floor = p.bottom;
  }
  // Above unless that leaves it too short to read a list in (a chat box
  // centred in the page leaves about 280px) and there is more room below.
  const above = ceiling - gap - m, below = vh - floor - gap - m;
  const up = above >= LIB_ROOM_USEFUL || above >= below;
  lib.dataset.dock = left + width / 2 > vw / 2 ? "right" : "left";
  lib.style.left = lib.dataset.dock === "left" ? left + "px" : "auto";
  lib.style.right = lib.dataset.dock === "right" ? (vw - left - width) + "px" : "auto";
  lib.style.top = up ? "auto" : (floor + gap) + "px";
  lib.style.bottom = up ? (vh - ceiling + gap) + "px" : "auto";
  // It fits what it holds, up to the usual height (a sign-in note or one
  // prompt in a 520px box was mostly empty), or is the height the user
  // dragged it to. Ticking a prompt changes nothing inside it in height: the
  // foot keeps to one line (see libFootHtml).
  const room = Math.max(160, up ? above : below);
  if (sheetSize.h) {
    const h = Math.round(Math.min(room, Math.max(SHEET_H_MIN, sheetSize.h)));
    lib.style.height = h + "px";
    lib.style.maxHeight = h + "px";
  } else {
    lib.style.height = "";
    lib.style.maxHeight = Math.round(Math.min(room, LIB_HEIGHT)) + "px";
  }
  lib.dataset.side = up ? "above" : "below";
  positionPeek();
}

function libraryItems() {
  const q = searchQuery.trim().toLowerCase();
  if (libView === "recent") {
    return enhanceHistory
      .filter((h) => !q || `${h.enhanced} ${h.original}`.toLowerCase().includes(q))
      .map((h) => ({ kind: "recent", h }));
  }
  const tag = q.startsWith("#") ? q.slice(1) : null;
  const list = savedPrompts
    .filter((p) => !q || (tag !== null
      ? (p.tags || []).some((t) => t.toLowerCase().startsWith(tag))
      : [p.title, p.content, ...(p.tags || [])].join(" ").toLowerCase().includes(q)))
    .map((p) => ({ kind: "saved", p }));
  // Saved prompts only. What is in the chat box used to lead the list as a
  // "Save …" row, there only when the box had text; + New in the head is
  // the one way to write a prompt here now, with or without a draft.
  return list;
}

function libVerb() {
  return norm(getCurrentInputText()) ? "Replace" : "Insert";
}

/** The Shortcuts chip is expanded while the map it opens is up. */
function syncHelpChipExpanded() {
  document.getElementById("pm-help-btn")?.setAttribute("aria-expanded", String(keyMapOpen));
}

function renderLibrary() {
  const lib = document.getElementById("pm-library");
  if (!lib || !panelOpen) return;
  syncHelpChipExpanded();
  const active = document.activeElement;
  const focusId = lib.contains(active) ? active.id : null;
  const caret = active?.id === "pm-lib-q" ? active.selectionStart : null;

  lib.dataset.page = libPage;
  lib.innerHTML = libHeadHtml() + libBodyHtml() + (libPage === "list" ? `<div class="pm-lib-foot" id="pm-lib-foot">${libFootHtml()}</div>` : "") +
    (libMenu ? libMenuHtml() : "") + SHEET_GRIPS;

  const again = focusId && lib.querySelector(`[id="${focusId}"]`);
  if (again) {
    again.focus({ preventScroll: true });
    if (caret !== null && again.setSelectionRange) again.setSelectionRange(caret, caret);
  }
  afterListRender(lib);
  positionLibrary();
  refreshPeek();
}

/** Typing in the search box redraws the rows only: rebuilding the input under
 *  an IME composition would throw the composition away. */
function renderLibraryList() {
  const lib = document.getElementById("pm-library");
  if (!lib || !panelOpen || libPage !== "list") return;
  const list = lib.querySelector("#pm-lib-list");
  if (list) list.innerHTML = libRowsHtml();
  const foot = lib.querySelector("#pm-lib-foot");
  if (foot) foot.innerHTML = libFootHtml();
  afterListRender(lib);
  refreshPeek();
}

function afterListRender(lib) {
  const list = lib.querySelector("#pm-lib-list");
  if (list) { watchScrollable(list); markScrollable(list); }
  lib.querySelector(".pm-lib-row.pm-sel")?.scrollIntoView({ block: "nearest" });
  syncActiveDescendant();
}

function syncActiveDescendant() {
  const q = document.getElementById("pm-lib-q");
  const row = document.querySelector("#pm-library .pm-lib-row.pm-sel");
  if (!q) return;
  if (row) q.setAttribute("aria-activedescendant", row.id);
  else q.removeAttribute("aria-activedescendant");
}

function libHeadHtml() {
  // × on every page, last in the row where a window keeps it. The sheet sits
  // where the Library chip was, so the chip cannot be its toggle; without this
  // the way out was esc or a click somewhere else, and neither is on screen.
  // The grip it is dragged by, first in every head; ↙ once it has been moved.
  const grip = `<span class="pm-lib-move" title="Drag to move. Double-click to put it back on the chat box." aria-hidden="true">${LIB_ICON.grip}</span>`;
  const home = sheetPos
    ? `<button type="button" class="pm-lib-icon" id="pm-lib-home" data-act="home" aria-label="Put the library back on the chat box" data-pm-tip="Back on the chat box">\u2199</button>`
    : "";
  const more = home + `<button type="button" class="pm-lib-icon" id="pm-lib-more" data-act="menu" aria-label="Library menu" aria-haspopup="menu" aria-expanded="${libMenu}">${LIB_ICON.more}</button>` +
    `<button type="button" class="pm-lib-icon" id="pm-lib-close" data-act="close" aria-label="Close the library" data-pm-tip="Close" data-pm-key="Esc">${LIB_ICON.close}</button>`;
  if (libPage === "privacy" || libPage === "feedback" || libPage === "edit") {
    const title = { privacy: "Privacy", feedback: "Send feedback",
      edit: libEdit?.id != null ? "Edit prompt" : "New prompt" }[libPage];
    return `<div class="pm-lib-head pm-lib-head-sub">${grip}` +
      `<button type="button" class="pm-lib-icon" id="pm-lib-back" data-act="back" aria-label="Back to the library">${LIB_ICON.back}</button>` +
      `<span class="pm-lib-head-title">${title}</span>${more}</div>`;
  }
  if (libPage === "signin") {
    return `<div class="pm-lib-head pm-lib-head-sub">${grip}<span class="pm-lib-head-title pm-lib-head-plain">Library</span>${more}</div>`;
  }
  // Short enough to fit beside the grip, Saved | History, +, ⋯ and × in a
  // 384px sheet; "Search 5 prompts" lost its last letters there. Once the
  // sheet has been moved its head also carries ↙, and it is just "Search".
  const placeholder = sheetPos ? "Search" : libView === "saved" ? "Search prompts" : "Search history";
  return `<div class="pm-lib-head">${grip}` +
    `<label class="pm-lib-search">${LIB_ICON.search}` +
    `<input id="pm-lib-q" type="text" autocomplete="off" spellcheck="false" placeholder="${placeholder}" value="${escHtml(searchQuery)}"` +
    ` aria-label="Search the library" role="combobox" aria-expanded="true" aria-controls="pm-lib-list" aria-autocomplete="list"></label>` +
    `<div class="pm-lib-views" role="group" aria-label="Show">` +
    `<button type="button" id="pm-lib-view-saved" data-view="saved" aria-pressed="${libView === "saved"}" title="Prompts you chose to keep">Saved</button>` +
    `<button type="button" id="pm-lib-view-recent" data-view="recent" aria-pressed="${libView === "recent"}" title="Every rewrite you have made">History</button></div>` +
    // A + of its own, not a third tab: the search box needs the room in a
    // 368px sheet, and New is a thing to do, not a list to show.
    `<button type="button" class="pm-lib-icon pm-lib-new" id="pm-lib-new" data-act="new" aria-label="New prompt" data-pm-tip="New prompt">${LIB_ICON.plus}</button>` +
    more + `</div>`;
}

function libBodyHtml() {
  if (libPage === "signin") {
    return `<div class="pm-lib-page">` +
      `<p class="pm-lib-lead">Your library lives in your account.</p>` +
      `<p class="pm-lib-note">Saved prompts, your rewrite history and context you attach are kept there, so they follow you across sites. ⊕ still rewrites without one.</p>` +
      `<button type="button" class="pm-lib-primary" id="pm-lib-signin" data-act="signin">Sign in</button></div>`;
  }
  if (libPage === "privacy") {
    const row = (id, on, label, desc) =>
      `<label class="pm-lib-setting"><span><span class="pm-lib-setting-label">${label}</span><span class="pm-lib-setting-desc">${desc}</span></span>` +
      `<input type="checkbox" class="pm-lib-switch" id="${id}"${on ? " checked" : ""}></label>`;
    return `<div class="pm-lib-page">` +
      row("pm-tracking-toggle", promptTrackingEnabled, "Prompt tracking", "Logs the prompts you send on these sites to improve future suggestions.") +
      row("pm-context-toggle", contextEnabled, "Conversation context", "Reads recent messages in this chat when you ask for a rewrite, for that request only.") +
      row("pm-slash-toggle", slashEnabled, "Type // for saved prompts", "Opens your saved prompts at the cursor in the chat box.") +
      row("pm-tips-toggle", !tips.off, "Tips on the page", "Short hints the first time you use each feature.") +
      `</div>`;
  }
  if (libPage === "edit" && libEdit) return libEditHtml();
  if (libPage === "feedback") {
    return `<div class="pm-lib-page pm-lib-form">` +
      `<label class="pm-lib-field"><span>Kind</span><select id="pm-feedback-type" class="pm-lib-input">` +
      `<option value="bug">Something is broken</option><option value="feature">An idea</option><option value="general" selected>General</option></select></label>` +
      `<label class="pm-lib-field"><span>Message</span><textarea id="pm-feedback-message" class="pm-lib-input" rows="4" placeholder="What happened, or what you would like"></textarea></label>` +
      `<label class="pm-lib-field"><span>Email, for a reply</span><input id="pm-feedback-email" class="pm-lib-input" type="email" placeholder="you@example.com"></label>` +
      `<div class="pm-lib-form-row"><button type="button" class="pm-lib-primary" id="pm-feedback-submit" data-act="sendfeedback">Send</button>` +
      `<span class="pm-lib-status" id="pm-feedback-status" role="status"></span></div>` +
      `<div class="pm-lib-recent-feedback" id="pm-feedback-recent"></div></div>`;
  }
  return `<div class="pm-lib-list" id="pm-lib-list" role="listbox" aria-label="${libView === "saved" ? "Saved prompts" : "Rewrite history"}">${libRowsHtml()}</div>`;
}

function libRowsHtml() {
  if (isLoadingTab || (libView === "recent" && !libHistoryLoaded)) {
    return `<div class="pm-lib-skeleton" aria-label="Loading">${"<div><i></i><i></i></div>".repeat(3)}</div>`;
  }
  const list = libraryItems();
  libSel = Math.max(0, Math.min(libSel, list.length - 1));
  if (!list.length) {
    const q = searchQuery.trim();
    if (q) return `<div class="pm-lib-empty"><b>Nothing matches “${escHtml(q)}”</b>Search looks at titles, text and tags. Start with # to match a tag.</div>`;
    if (libView === "recent") return `<div class="pm-lib-empty"><b>No history yet</b>Every rewrite you make with ⊕ shows up here. Save the ones worth keeping.</div>`;
    return `<div class="pm-lib-empty"><b>Your library is empty</b>Write one with + New, or save a rewrite from its card.</div>`;
  }
  const verb = libVerb();
  return list.map((it, i) => {
    const sel = i === libSel ? " pm-sel" : "";
    const id = `pm-lib-row-${i}`;
    if (it.kind === "recent") {
      const h = it.h;
      const ago = h.timestamp ? getTimeAgo(h.timestamp) : "";
      let row = `<div class="pm-lib-row pm-lib-row-recent${sel}" id="${id}" data-i="${i}" role="option" aria-selected="${Boolean(sel)}">` +
        `<span class="pm-lib-dot" aria-hidden="true"></span><div class="pm-lib-text"><div class="pm-lib-title pm-lib-clamp">${escHtml(norm(h.enhanced))}</div>` +
        `<div class="pm-lib-preview">from “${escHtml(norm(h.original))}”${ago ? " · " + ago : ""}</div></div>` +
        `<div class="pm-lib-acts"><button type="button" class="pm-lib-icon" data-act="more" aria-label="More actions" aria-expanded="${libRowMenu === "r" + i}">${LIB_ICON.more}</button>` +
        `<button type="button" class="pm-lib-verb" data-act="insert">${verb}</button></div></div>`;
      if (libRowMenu === "r" + i) {
        row += `<div class="pm-lib-rowmenu"><button type="button" data-act="keep" data-i="${i}">Save to library</button><button type="button" data-act="copy" data-i="${i}">Copy</button></div>`;
      }
      return row;
    }
    const p = it.p;
    if (libConfirm === p.id) {
      return `<div class="pm-lib-confirm" data-i="${i}" role="alertdialog" aria-label="Delete this prompt?"><span>Delete “${escHtml(promptTitle(p))}”?</span>` +
        `<button type="button" data-act="keepit" data-i="${i}">Keep</button><button type="button" class="pm-lib-danger" data-act="del" data-i="${i}" id="pm-lib-del">Delete</button></div>`;
    }
    const att = selectedIds.has(p.id);
    // A prompt the user named leads with that name and two lines of its text.
    // One they did not name leads with its own words, three lines of them: a
    // title cut from its first sentence read as a name nobody had given it.
    const words = p.title
      ? `<div class="pm-lib-title">${escHtml(p.title)}</div><div class="pm-lib-preview pm-lib-clamp">${escHtml(norm(p.content))}</div>`
      : `<div class="pm-lib-title pm-lib-untitled">${escHtml(norm(p.content))}</div>`;
    // The tick is what a click on the row leaves behind: in context or not.
    // aria-checked, because aria-selected already means "highlighted" here
    // (the search box points at that row with aria-activedescendant).
    let row = `<div class="pm-lib-row${sel}${att ? " pm-att" : ""}" id="${id}" data-i="${i}" role="option" aria-selected="${Boolean(sel)}" aria-checked="${att}">` +
      `<span class="pm-lib-tick" aria-hidden="true">${LIB_ICON.tick}</span><div class="pm-lib-text">${words}${promptMetaHtml(p)}</div>` +
      `<div class="pm-lib-acts">` +
      `<button type="button" class="pm-lib-icon" data-act="more" aria-label="More actions" aria-expanded="${libRowMenu === p.id}">${LIB_ICON.more}</button>` +
      `<button type="button" class="pm-lib-verb" data-act="insert" data-pm-tip="${verb} into the chat box" data-pm-key="${CMD_ENTER}">${verb}</button></div></div>`;
    if (libRowMenu === p.id) {
      row += `<div class="pm-lib-rowmenu"><button type="button" data-act="improve" data-i="${i}" title="Rewrite this saved prompt, then update it or save a new one">Improve</button>` +
        `<button type="button" data-act="edit" data-i="${i}">Edit</button><button type="button" class="pm-lib-danger" data-act="ask" data-i="${i}">Delete</button></div>`;
    }
    return row;
  }).join("");
}

function libFootHtml() {
  // One line in every state. A foot that gained a line when the first prompt
  // was ticked grew the sheet upward under the pointer.
  const parts = [];
  const left = usageData.limit - usageData.count;
  if (libSignedIn && usageData.known && left <= 3) {
    // "today" gives way beside the context count, to keep the foot one line.
    const today = selectedIds.size ? "" : " today";
    parts.push(`<span class="pm-lib-low">${left <= 0 ? "No rewrites left today" : `${left} rewrite${left === 1 ? "" : "s"} left${today}`}</span>`);
  }
  const k = (key, what) => `<span><kbd>${key}</kbd>${what}</span>`;
  if (!selectedIds.size) {
    parts.push(`<span class="pm-lib-hints">` + (libView === "recent"
      ? k(ENTER_KEY, libVerb().toLowerCase()) + k("→", "read") + k("esc", "close")
      : k(ENTER_KEY, "add to context") + k(CMD_ENTER, libVerb().toLowerCase()) + k("→", "read")) + `</span>`);
    return parts.join("");
  }
  // What the ticks are for, said where they are ticked: context shapes the
  // ⊕ rewrite and is never sent to the chat on its own. With text in the box
  // the next step is offered; without it, the keys stay, short.
  const them = selectedIds.size === 1 ? "it" : "them";
  parts.push(`<span class="pm-lib-att-count" title="Context for your next ⊕ rewrite. It is not sent to the chat on its own.">${selectedIds.size} in context</span>` +
    `<button type="button" class="pm-lib-link" data-act="clear">Clear</button>`);
  parts.push(norm(getCurrentInputText()).length >= 3
    ? `<button type="button" class="pm-lib-verb pm-lib-foot-go" data-act="rewrite" title="Rewrite what is in the chat box with ${them} as context">Rewrite with ${them}</button>`
    : `<span class="pm-lib-hints pm-lib-hints-also">${k(ENTER_KEY, "add")}${k(CMD_ENTER, libVerb().toLowerCase())}</span>`);
  return parts.join("");
}

function libMenuHtml() {
  const style = (s) => `<button type="button" data-style="${s}" aria-pressed="${currentMode === s}">${STYLE_NAMES[s]}</button>`;
  const left = usageData.limit - usageData.count;
  return `<div class="pm-lib-menu" role="menu" aria-label="Library menu">` +
    `<div class="pm-lib-menu-group"><div class="pm-lib-menu-cap">Rewrite style for ⊕</div>` +
    `<div class="pm-lib-views pm-lib-views-wide" role="group" aria-label="Default rewrite style">${STYLES.map(style).join("")}</div></div>` +
    `<hr>` +
    `<button type="button" class="pm-lib-mi" role="menuitem" data-act="voice">Voice input<span>${VOICE_KEY}</span></button>` +
    `<button type="button" class="pm-lib-mi" role="menuitem" data-act="shortcuts">Keyboard shortcuts<span>?</span></button>` +
    `<button type="button" class="pm-lib-mi" role="menuitem" data-act="privacy">Privacy settings…</button>` +
    `<button type="button" class="pm-lib-mi" role="menuitem" data-act="feedback">Send feedback…</button>` +
    (libSignedIn && usageData.known
      ? `<hr><div class="pm-lib-menu-meta">${Math.max(0, usageData.count)} of ${usageData.limit} rewrites used today${left <= 0 ? " — none left" : ""}</div>`
      : "") +
    `</div>`;
}

// ── What the sheet does ──

/**
 * Rewrite a saved prompt itself. Opens the same card as ⊕, with the saved
 * prompt as the original; styles and versions work as usual, and the verb is
 * "Update saved prompt". It never matches itself as related context.
 */
async function improveSavedPrompt(p) {
  closeLibrary();
  if (enhanceInFlight) { showToast("Already enhancing \u2014 hang on a moment.", "info"); return; }
  if (cardState !== "idle") {
    // Starting over would drop the pending draft without a word.
    showToast("Use or discard the draft in the pill first.", "info");
    revealCard();
    return;
  }
  const route = await resolveEnhanceRoute();
  if (!route || cardState !== "idle") return;
  cardSubject = { id: p.id, title: promptTitle(p), content: p.content };
  enhanceInFlight = true;
  showStreamingDiffModal(p.content);
  try {
    if (route.route === "direct") await runDirectEnhance(p.content, route);
    else await runBackendEnhance(p.content, { excludedIds: [p.id], excluded: [] });
  } catch (err) {
    console.error("Prompt Memory: improve failed", err);
    failStreamingModal(err?.message || "Enhancement failed. Please try again.");
  } finally {
    enhanceInFlight = false;
  }
}

async function libInsert(text, logId) {
  // The chat box is about to change: a card the sheet folded away would come
  // back stale. The pill keeps the draft.
  libFoldedCard = null;
  closeLibrary();
  const applied = await applyOrFallback(text, null);
  if (applied) {
    showApplied(null);
    if (logId) approveEnhancement(logId);
  }
}

/** Save from the sheet: the Save row, or a History rewrite. The form sits on the row. */
function libSaveText(text, rowEl) {
  const lib = document.getElementById("pm-library");
  openSaveForm({
    text,
    anchor: (rowEl || lib)?.getBoundingClientRect(),
    onClose: () => { if (panelOpen) { renderLibrary(); focusLibrarySearch(); } },
  });
}

// ── Saving: one small form, wherever a prompt can be saved from ──
//
// There were four ways to save and none asked for anything: the library's
// Save row, ⌘S on the card, History's "Save to library" and Improve's save as
// new. Each wrote at once and named the prompt after its first sentence, so
// the library filled with names nobody gave. Every route now opens this form
// by the thing being saved: a name, left empty unless the user types one (an
// unnamed prompt is shown by its own words), tags they already use one click
// away, and the text itself. ↵ saves, so saving is still one keystroke.

let saveForm = null;   // { text, busy, tags: Set, onClose, successMessage, returnFocus }

/** The user's own tags, most used first: the ones worth a single click. */
function savedTagSuggestions(limit = 6) {
  const counts = new Map();
  for (const p of savedPrompts) for (const t of p.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
}

async function openSaveForm({ text, title = "", anchor = null, onClose = null, successMessage = "" }) {
  closeSaveForm(false);
  text = String(text || "").trim();
  if (!text) return;
  const auth = await getAuth();
  if (!auth || isTokenExpired(auth.token)) {
    showToast("Sign in to save prompts to your library.", "info", { label: "Sign in", run: () => openSettings() });
    return;
  }
  if (!(await ensureDataConsent())) return;
  saveForm = { text, busy: false, tags: new Set(), onClose, successMessage, returnFocus: document.activeElement };
  const el = document.createElement("div");
  el.id = "pm-save";
  el.className = "pm-lib pm-save";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Save to your library");
  el.innerHTML =
    `<div class="pm-save-head">Save to your library</div>` +
    `<label class="pm-save-field"><span>Name</span><input id="pm-save-title" class="pm-lib-input" type="text" autocomplete="off" spellcheck="false" maxlength="120"` +
    ` value="${escHtml(title)}" placeholder="Optional. Unnamed prompts show their words"></label>` +
    `<div class="pm-save-field"><span>Tags</span><div class="pm-save-tags" id="pm-save-tags"></div>` +
    `<input id="pm-save-newtags" class="pm-lib-input" type="text" autocomplete="off" spellcheck="false" placeholder="New tags, comma separated" aria-label="New tags"></div>` +
    `<div class="pm-save-snip">${escHtml(norm(text))}</div>` +
    `<div class="pm-save-foot"><span class="pm-save-status" id="pm-save-status" role="status"><kbd>${ENTER_KEY}</kbd>save<kbd>esc</kbd>cancel</span>` +
    `<button type="button" class="pm-lib-verb pm-lib-verb-quiet" data-act="cancel">Cancel</button>` +
    `<button type="button" class="pm-lib-verb" data-act="save" id="pm-save-go">Save</button></div>`;
  document.body.appendChild(el);
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.tag !== undefined) {
      const t = b.dataset.tag;
      if (saveForm.tags.has(t)) saveForm.tags.delete(t); else saveForm.tags.add(t);
      renderSaveTags();
    } else if (b.dataset.act === "cancel") closeSaveForm();
    else if (b.dataset.act === "save") submitSaveForm();
  });
  el.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    // Stopped here: esc and ↵ belong to this form, not to the sheet or the
    // card it opened from, nor to the host page behind them.
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSaveForm(); }
    else if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); e.stopPropagation(); submitSaveForm(); }
  });
  renderSaveTags();
  if (!promptsLoaded) fetchSavedPrompts().then(renderSaveTags);
  positionSaveForm(anchor);
  const input = document.getElementById("pm-save-title");
  input.focus({ preventScroll: true });
  input.select();
}

// A press anywhere else cancels the form, as it closes the sheet.
document.addEventListener("pointerdown", (e) => {
  if (saveForm && !e.target.closest?.("#pm-save")) closeSaveForm(false);
}, true);

function renderSaveTags() {
  const box = document.getElementById("pm-save-tags");
  if (!box || !saveForm) return;
  const tags = [...new Set([...savedTagSuggestions(), ...saveForm.tags])];
  box.hidden = !tags.length;
  box.innerHTML = tags.map((t) =>
    `<button type="button" data-tag="${escHtml(t)}" aria-pressed="${saveForm.tags.has(t)}">#${escHtml(t)}</button>`).join("");
}

/** Beside what is being saved: above it when there is room, else below. */
function positionSaveForm(anchor) {
  const el = document.getElementById("pm-save");
  if (!el) return;
  const vw = window.innerWidth, vh = window.innerHeight, m = 12, gap = 8;
  const width = Math.min(340, vw - 2 * m);
  el.style.width = width + "px";
  const r = anchor || { left: (vw - width) / 2, right: (vw + width) / 2, top: vh / 2, bottom: vh / 2 };
  el.style.left = Math.max(m, Math.min(r.right - width, vw - width - m)) + "px";
  const h = el.offsetHeight;
  if (r.top - gap - m >= h || r.top > vh - r.bottom) {
    el.style.top = Math.max(m, r.top - gap - h) + "px";
  } else {
    el.style.top = Math.min(vh - h - m, r.bottom + gap) + "px";
  }
}

function closeSaveForm(restoreFocus = true) {
  const f = saveForm;
  saveForm = null;
  document.getElementById("pm-save")?.remove();
  if (!f) return;
  if (restoreFocus && f.returnFocus?.isConnected) f.returnFocus.focus({ preventScroll: true });
  f.onClose?.();
}

async function submitSaveForm() {
  const f = saveForm;
  if (!f || f.busy) return;
  const title = document.getElementById("pm-save-title")?.value.trim() || "";
  const typed = (document.getElementById("pm-save-newtags")?.value || "")
    .split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
  const tags = [...new Set([...f.tags, ...typed])];
  const go = document.getElementById("pm-save-go");
  f.busy = true;
  if (go) { go.disabled = true; go.textContent = "Saving\u2026"; }
  const outcome = await createSavedPrompt(f.text, title, tags);
  f.busy = false;
  if (saveForm !== f) return;   // closed while the request was out
  if (outcome === "failed") {
    if (go) { go.disabled = false; go.textContent = "Save"; }
    const status = document.getElementById("pm-save-status");
    if (status) { status.textContent = "Could not save. Check your connection and try again."; status.classList.add("pm-save-error"); }
    return;
  }
  if (outcome === "duplicate") {
    closeSaveForm();
    // Nothing was written, so nothing is refetched; the user is shown where it is.
    showToast("Already in your library", "info", { label: "Show", run: () => showInLibrary(f.text) });
    return;
  }
  const id = lastSavedPromptId;
  statsBump("saves");
  tipDone("save");
  // Gone as soon as the server says yes; the list catches up behind it.
  closeSaveForm();
  showToast(f.successMessage || (title ? `Saved \u201c${clipText(title, 40)}\u201d to your library` : "Saved to your library"),
    "success", id ? { label: "Undo", run: () => undoSave(id) } : null);
  await fetchSavedPrompts();
  if (panelOpen) renderLibrary();
}

// ── Save a prompt you already sent ──
//
// A prompt is worth keeping once its answer has been read, and by then it has
// been sent and the chat box is empty. Resting the pointer on one of your own
// messages shows a bookmark beside its words, which opens the save form.
// One floating button, placed over the page rather than added to the host's
// markup, so the host re-rendering its messages cannot break it or be broken
// by it. The selectors are the ones each site marks the user's side with:
// ChatGPT, Gemini, and Claude.

// How each site marks the user's side, and its hidden "You said", are in sites.js.
const SENT_PROMPT_SELECTOR = PM_SITES.sentPrompt;
const SENT_PROMPT_WORDS = PM_SITES.sentPromptWords;
const VISUALLY_HIDDEN = PM_SITES.visuallyHidden;
const BOOKMARK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 2.5h7v11L8 10.8l-3.5 2.7z"/></svg>';
let msgSaveTarget = null;
let msgSaveHideTimer = null;
let msgSaveQueued = null;

/** The element holding the words: Gemini wraps them inside its user-query. */
function sentPromptWords(el) {
  return (el.matches?.(SENT_PROMPT_WORDS) ? el : el.querySelector?.(SENT_PROMPT_WORDS)) || el;
}

function sentPromptText(el) {
  const words = sentPromptWords(el);
  let text = (words.innerText || "").trim();
  for (const hidden of words.querySelectorAll(VISUALLY_HIDDEN)) {
    const h = (hidden.textContent || "").trim();
    if (h && text.startsWith(h)) text = text.slice(h.length).trim();
  }
  return text;
}

/** Where the words are, which is not where the element is: ChatGPT's spans the column. */
function sentPromptRect(el) {
  const words = sentPromptWords(el);
  const range = document.createRange();
  range.selectNodeContents(words);
  const r = range.getBoundingClientRect();
  return r.width && r.height ? r : words.getBoundingClientRect();
}

function msgSaveButton() {
  let b = document.getElementById("pm-msg-save");
  if (!b) {
    b = document.createElement("button");
    b.id = "pm-msg-save";
    b.type = "button";
    b.className = "pm-msg-save";
    b.title = "Save this prompt to your library";
    b.setAttribute("aria-label", "Save this prompt to your library");
    b.innerHTML = BOOKMARK_SVG;
    b.hidden = true;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const el = msgSaveTarget;
      hideMsgSave();
      if (el?.isConnected) openSaveForm({ text: sentPromptText(el), anchor: sentPromptRect(el) });
    });
    document.body.appendChild(b);
  }
  return b;
}

function showMsgSave(el) {
  clearTimeout(msgSaveHideTimer);
  msgSaveHideTimer = null;
  msgSaveTarget = el;
  const b = msgSaveButton();
  const r = sentPromptRect(el);
  const size = 28, gap = 8;
  // Left of the words: the user's messages sit on the right on these sites,
  // with the host's own buttons (copy, edit) under them, not beside.
  let left = r.left - size - gap;
  if (left < 8) left = Math.min(window.innerWidth - size - 8, r.right + gap);
  b.style.left = Math.round(left) + "px";
  b.style.top = Math.round(Math.max(8, r.top + Math.min(0, (r.height - size) / 2))) + "px";
  b.hidden = false;
}

function hideMsgSave() {
  clearTimeout(msgSaveHideTimer);
  msgSaveHideTimer = null;
  msgSaveTarget = null;
  const b = document.getElementById("pm-msg-save");
  if (b) b.hidden = true;
}

/** Pointer moved: over one of the user's sent messages, or on its way to the bookmark? */
function trackSentPrompt(e) {
  if (msgSaveQueued) { msgSaveQueued = e; return; }
  msgSaveQueued = e;
  requestAnimationFrame(() => {
    const ev = msgSaveQueued;
    msgSaveQueued = null;
    if (!libSignedIn || saveForm) { if (msgSaveTarget) hideMsgSave(); return; }
    const t = ev.target;
    if (t.closest?.("#pm-msg-save")) { clearTimeout(msgSaveHideTimer); msgSaveHideTimer = null; return; }
    const el = t.closest?.(SENT_PROMPT_SELECTOR);
    if (el && !el.closest("[contenteditable='true'], textarea") && sentPromptText(el).length >= 3) {
      if (el !== msgSaveTarget || document.getElementById("pm-msg-save")?.hidden) showMsgSave(el);
      else { clearTimeout(msgSaveHideTimer); msgSaveHideTimer = null; }
      return;
    }
    // Long enough to cross the gap between the words and the bookmark.
    if (msgSaveTarget && !msgSaveHideTimer) msgSaveHideTimer = setTimeout(hideMsgSave, 300);
  });
}

document.addEventListener("pointermove", trackSentPrompt, { capture: true, passive: true });
// The page moved under it: the bookmark would point at the wrong message.
window.addEventListener("scroll", (e) => {
  if (msgSaveTarget && !(e.target instanceof Element && e.target.closest("#pm-library, #pm-caret, #pm-card, #pm-peek"))) hideMsgSave();
}, true);

async function undoSave(id) {
  if (!(await deleteSavedPrompt(id))) { showToast("Could not undo. Delete it from the library.", "error"); return false; }
  if (selectedIds.has(id)) toggleAttachment({ id });
  await fetchSavedPrompts();
  if (panelOpen) renderLibrary();
  showToast("Removed from your library", "info");
  return true;
}

/** Open the library on a prompt that is already there. */
function showInLibrary(text) {
  togglePanel(true);
  searchQuery = norm(text).slice(0, 40);
  const q = document.getElementById("pm-lib-q");
  if (q) q.value = searchQuery;
  renderLibraryList();
}

/** The row element for list index i (the highlighted one when i is undefined). */
function libRowEl(i) {
  return document.querySelector(`#pm-library .pm-lib-row[data-i="${i ?? libSel}"]`);
}

function libAct(act, i) {
  const list = libraryItems();
  const it = list[i ?? libSel];
  // What a click on the row, or ↵, means for this kind of row. A saved prompt
  // is ticked as context for the next rewrite and the sheet stays open, so
  // several can be picked in a row; putting its text in the chat box is the
  // row's Insert button, or ⌘↵. A past rewrite cannot be context (the server
  // looks context up among saved prompts), so its row still inserts.
  if (act === "primary") act = it?.kind === "saved" ? "attach" : "insert";
  switch (act) {
    case "insert":
      if (!it) return;
      if (it.kind === "recent") { libInsert(it.h.enhanced, it.h.log_id); return; }
      libInsert(it.p.content);
      return;
    case "attach":
      if (it?.kind === "saved") toggleAttachment(it.p);
      return;
    case "more":
      if (!it) return;
      libRowMenu = it.kind === "recent" ? (libRowMenu === "r" + (i ?? libSel) ? null : "r" + (i ?? libSel)) : (libRowMenu === it.p.id ? null : it.p.id);
      libSel = i ?? libSel;
      renderLibraryList();
      return;
    case "edit":
      if (it?.kind === "saved") { libRowMenu = null; openPromptPage(it.p); }
      return;
    case "improve":
      if (it?.kind === "saved") { libRowMenu = null; improveSavedPrompt(it.p); }
      return;
    case "ask":
      if (it?.kind === "saved") { libConfirm = it.p.id; libRowMenu = null; renderLibraryList(); document.getElementById("pm-lib-del")?.focus(); }
      return;
    case "keepit":
      libConfirm = null; renderLibraryList(); focusLibrarySearch();
      return;
    case "del":
      if (it?.kind === "saved") {
        const id = it.p.id;
        libConfirm = null;
        deleteSavedPrompt(id).then(async (ok) => {
          if (!ok) { showToast("Could not delete", "error"); renderLibraryList(); return; }
          if (selectedIds.has(id)) toggleAttachment({ id });
          await fetchSavedPrompts();
          renderLibrary();
          focusLibrarySearch();
        });
      }
      return;
    case "keep":
      if (it?.kind === "recent") { libRowMenu = null; libSaveText(it.h.enhanced, libRowEl(i)); }
      return;
    case "copy":
      if (it?.kind === "recent") {
        libRowMenu = null;
        navigator.clipboard.writeText(it.h.enhanced).then(
          () => showToast("Copied", "success"),
          () => showToast("Could not copy", "error"));
        renderLibraryList();
      }
      return;
  }
}

function onLibraryClick(e) {
  const b = e.target.closest("button");
  if (b?.dataset.tag !== undefined && libPage === "edit" && libEdit) {
    // In place, not by a redraw, so the keyboard stays where it was.
    const t = b.dataset.tag;
    if (libEdit.tags.has(t)) libEdit.tags.delete(t); else libEdit.tags.add(t);
    b.setAttribute("aria-pressed", String(libEdit.tags.has(t)));
    return;
  }
  if (b?.dataset.view) {
    libView = b.dataset.view;
    libSel = 0; libRowMenu = null; libConfirm = null;
    hidePeek();
    renderLibrary();
    focusLibrarySearch();
    if (libView === "recent" && !libHistoryLoaded) {
      fetchEnhanceHistory().then(() => { libHistoryLoaded = true; renderLibrary(); });
    }
    return;
  }
  if (b?.dataset.style) {
    setDefaultStyle(b.dataset.style);
    renderLibrary();
    return;
  }
  const act = b?.dataset.act;
  if (act === "menu") { libMenu = !libMenu; renderLibrary(); return; }
  if (libMenu && !e.target.closest(".pm-lib-menu")) { libMenu = false; renderLibrary(); if (!act) return; }
  switch (act) {
    case "close": closeLibrary(); return;
    case "home": resetSheetPosition(); return;
    case "back": libPage = "list"; libEdit = null; libMenu = false; renderLibrary(); focusLibrarySearch(); return;
    case "editcancel": leavePromptPage(); return;
    case "editsave": savePromptPage(); return;
    case "privacy": libPage = "privacy"; libMenu = false; renderLibrary(); return;
    // The search first: the map gives the keyboard back to whatever had it,
    // and the menu item that was clicked is gone once the menu closes.
    case "shortcuts": libMenu = false; renderLibrary(); focusLibrarySearch(); openShortcuts(); return;
    case "feedback":
      libPage = "feedback"; libMenu = false; renderLibrary();
      storageGet(["email"], (r) => { const el = document.getElementById("pm-feedback-email"); if (el && !el.value) el.value = r.email || ""; });
      loadRecentFeedback();
      return;
    case "voice": closeLibrary(); toggleVoice(); return;
    case "signin": openSettings(); return;
    case "clear": clearAttachments(); return;
    case "new": libMenu = false; openNewPrompt(); return;
    case "rewrite": libFoldedCard = null; closeLibrary(); handleEnhance(); return;
    case "sendfeedback": sendLibraryFeedback(); return;
  }
  const rowEl = e.target.closest("[data-i]");
  const i = rowEl ? Number(rowEl.dataset.i) : undefined;
  if (act) { libAct(act, i); return; }
  // A click on the row itself does what the row is for: see libAct("primary").
  if (rowEl?.classList.contains("pm-lib-row")) { libSel = i; libAct("primary", i); }
}

function onLibraryInput(e) {
  if (libPage === "edit" && libEdit) {
    const field = { "pm-edit-content": "content", "pm-edit-title": "title", "pm-edit-tags": "tagText" }[e.target.id];
    if (field) libEdit[field] = e.target.value;
    return;
  }
  if (e.target.id !== "pm-lib-q") return;
  searchQuery = e.target.value;
  libSel = 0; libRowMenu = null; libConfirm = null;
  hidePeek();
  renderLibraryList();
}

function onLibraryChange(e) {
  const id = e.target.id;
  if (id === "pm-tracking-toggle") { promptTrackingEnabled = e.target.checked; storageSet({ pm_tracking: promptTrackingEnabled }); }
  if (id === "pm-context-toggle") { contextEnabled = e.target.checked; storageSet({ pm_context: contextEnabled }); }
  if (id === "pm-slash-toggle") { slashEnabled = e.target.checked; storageSet({ pm_slash: slashEnabled }); }
  if (id === "pm-tips-toggle") { tips.off = !e.target.checked; storageSet({ pm_tips_off: tips.off }); if (tips.off) hideTip(); }
}

function onLibraryKeydown(e) {
  if (e.isComposing) return;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Escape") {
    e.preventDefault(); e.stopPropagation();
    if (libMenu || libRowMenu || libConfirm) { libMenu = false; libRowMenu = null; libConfirm = null; renderLibrary(); focusLibrarySearch(); return; }
    if (libPeek !== null) { hidePeek(); return; }
    if (libPage === "edit") { leavePromptPage(); return; }
    if (libPage === "privacy" || libPage === "feedback") {
      libPage = "list"; renderLibrary(); focusLibrarySearch(); return;
    }
    closeLibrary();
    return;
  }
  if (libPage === "edit" && mod && e.key === "Enter") {
    e.preventDefault(); e.stopPropagation(); savePromptPage(); return;
  }
  // The keys below drive the list from the search box, as in a combobox.
  if (e.target.id !== "pm-lib-q" || libPage !== "list") return;
  const n = libraryItems().length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!n) return;
    libSel = (libSel + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
    libRowMenu = null;
    renderLibraryList();
    if (libPeek !== null) showPeek(libSel);   // an open preview follows the highlight
    return;
  }
  // → at the end of the query opens the whole prompt; ← puts it away. Only at
  // the end, so → still moves the caret through what was typed.
  if (e.key === "ArrowRight" && e.target.selectionStart === e.target.value.length && !mod && !e.shiftKey) {
    const it = libraryItems()[libSel];
    if (it) { e.preventDefault(); showPeek(libSel); }
    return;
  }
  if (e.key === "ArrowLeft" && libPeek !== null) {
    e.preventDefault();
    hidePeek();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault(); e.stopPropagation();
    if (!n) return;
    // ↵ does what a click does; ⌘↵ inserts. The other way round from before:
    // the keyboard and the pointer now agree on what picking a row means.
    const it = libraryItems()[libSel];
    libAct(mod && it?.kind === "saved" ? "insert" : "primary");
  }
}

// ── The whole prompt, beside the sheet ──
//
// A row shows two or three lines, and a saved prompt is often a paragraph.
// Reading one used to mean Edit, a modal. Resting the pointer on a row, or
// → from the search box, opens the whole of it beside the sheet, with the
// row's own actions under it.
//
// Hover waits 350ms with the pointer still over one row (a pointer crossing
// the list on its way somewhere else is not asking), then moves to the next
// row at once while one is open. Leaving waits 150ms, long enough to cross
// the gap into the preview to reach its buttons.
//
// Leaving is read from pointermove, not pointerleave. Both the list and the
// preview redraw under the pointer (a click on Attach relabels its button),
// and after the node under the pointer is replaced Chrome sends no leave
// event for its old ancestors: the preview stayed up after the pointer had
// gone.

const PEEK_OPEN_MS = 350;
const PEEK_SWITCH_MS = 60;
const PEEK_CLOSE_MS = 150;
let libPeek = null;           // the list index the preview shows, or null
let peekOpenTimer = null;
let peekCloseTimer = null;

function peekItem() {
  if (libPeek === null || !panelOpen || libPage !== "list") return null;
  const it = libraryItems()[libPeek];
  return it || null;
}

function peekHtml(it) {
  const verb = libVerb();
  const btn = (act, label, extra = "") => `<button type="button" class="pm-lib-verb${extra}" data-act="${act}">${label}</button>`;
  if (it.kind === "recent") {
    const h = it.h;
    return `<div class="pm-peek-head"><div class="pm-peek-title">Rewrite</div>` +
      `<div class="pm-lib-meta">${escHtml(STYLE_NAMES[h.mode] || "")}${h.timestamp ? `<span>${escHtml(getTimeAgo(h.timestamp))}</span>` : ""}</div></div>` +
      `<div class="pm-peek-body">${escHtml(h.enhanced)}<div class="pm-peek-from"><span>Rewritten from</span>${escHtml(h.original)}</div></div>` +
      `<div class="pm-peek-foot">${btn("copy", "Copy", " pm-lib-verb-quiet")}${btn("keep", "Save to library", " pm-lib-verb-quiet")}${btn("insert", verb)}</div>`;
  }
  const p = it.p;
  const att = selectedIds.has(p.id);
  return `<div class="pm-peek-head"><div class="pm-peek-title${p.title ? "" : " pm-peek-untitled"}">${escHtml(p.title || "Untitled prompt")}</div>` +
    promptMetaHtml(p) + `</div>` +
    `<div class="pm-peek-body">${escHtml(p.content)}</div>` +
    `<div class="pm-peek-foot">${btn("edit", "Edit", " pm-lib-verb-quiet")}` +
    btn("attach", att ? "Detach" : "Attach as context", " pm-lib-verb-quiet") + btn("insert", verb) + `</div>`;
}

/** Show the preview for list row i, or redraw it where it is. */
function showPeek(i) {
  clearTimeout(peekOpenTimer);
  clearTimeout(peekCloseTimer);
  peekCloseTimer = null;
  libPeek = i;
  const it = peekItem();
  if (!it) { hidePeek(); return; }
  let peek = document.getElementById("pm-peek");
  if (!peek) {
    peek = document.createElement("div");
    peek.id = "pm-peek";
    peek.className = "pm-lib pm-peek";
    peek.setAttribute("role", "region");
    // Its buttons run the row's verbs; the list works out which row from here.
    peek.addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act && libPeek !== null) libAct(act, libPeek);
    });
    document.body.appendChild(peek);
  }
  peek.setAttribute("aria-label", "The whole prompt");
  peek.dataset.i = String(i);
  peek.innerHTML = peekHtml(it);
  positionPeek();
  watchScrollable(peek.querySelector(".pm-peek-body"));
  markScrollable(peek.querySelector(".pm-peek-body"));
}

function hidePeek() {
  clearTimeout(peekOpenTimer);
  clearTimeout(peekCloseTimer);
  peekCloseTimer = null;
  libPeek = null;
  document.getElementById("pm-peek")?.remove();
}

/** Whether a row's clamped text runs past what it shows. */
function rowIsClipped(row) {
  return [...row.querySelectorAll(".pm-lib-clamp, .pm-lib-untitled")].some((el) => el.scrollHeight > el.clientHeight + 1);
}

/** Pointer came to rest on a row: open (or move) the preview after a beat. */
function schedulePeek(i) {
  clearTimeout(peekOpenTimer);
  if (libPeek === i) return;
  peekOpenTimer = setTimeout(() => showPeek(i), libPeek === null ? PEEK_OPEN_MS : PEEK_SWITCH_MS);
}

/** Every pointer move while the sheet is open: is it still on the sheet or the preview? */
function trackPeekPointer(e) {
  if (!panelOpen) return;
  const inside = Boolean(e.target.closest?.("#pm-library, #pm-peek"));
  if (inside) {
    clearTimeout(peekCloseTimer);
    peekCloseTimer = null;
  } else {
    clearTimeout(peekOpenTimer);     // it left before the preview was asked for
    if (libPeek !== null && !peekCloseTimer) peekCloseTimer = setTimeout(hidePeek, PEEK_CLOSE_MS);
  }
}

/** Redraw an open preview after the list changed under it. */
function refreshPeek() {
  if (libPeek === null) return;
  if (peekItem()) showPeek(libPeek); else hidePeek();
}

/**
 * Beside the sheet, on the side away from the pill's edge, where the page has
 * room. Where it has none (a narrow window), over the sheet itself: the
 * preview is the thing being looked at, and it goes when the pointer leaves.
 */
function positionPeek() {
  const peek = document.getElementById("pm-peek");
  const lib = document.getElementById("pm-library");
  if (!peek || !lib || lib.hidden) return;
  const r = lib.getBoundingClientRect();
  const vw = window.innerWidth, m = 12, gap = 8;
  const width = Math.min(360, vw - 2 * m);
  peek.style.width = width + "px";
  const leftRoom = r.left - gap - m, rightRoom = vw - r.right - gap - m;
  let left;
  if (leftRoom >= width && (leftRoom >= rightRoom || rightRoom < width)) left = r.left - gap - width;
  else if (rightRoom >= width) left = r.right + gap;
  else left = Math.max(m, Math.min(r.left, vw - width - m));
  peek.style.left = left + "px";
  peek.style.maxHeight = Math.max(200, r.height) + "px";
  // Level with the sheet's edge nearest the pill, so the two read as a pair.
  if (lib.dataset.side === "below") { peek.style.top = r.top + "px"; peek.style.bottom = "auto"; }
  else { peek.style.bottom = (window.innerHeight - r.bottom) + "px"; peek.style.top = "auto"; }
  // But never on the context chips or the chat box: the chips are where a
  // tick shows up, and the preview sat on them (seen live). It rises above
  // whichever it would cover, if that leaves it room to be read.
  const obstacles = [document.getElementById("pm-rail"), findComposer() && { getBoundingClientRect: () => composerFrame(findComposer()) }]
    .filter((o) => o && !o.hidden).map((o) => o.getBoundingClientRect()).filter((o) => o && o.width);
  for (const o of obstacles) {
    const pr = peek.getBoundingClientRect();
    if (!(pr.left < o.right && pr.right > o.left && pr.top < o.bottom && pr.bottom > o.top)) continue;
    const limit = o.top - gap;
    if (limit - m < 160) continue;
    peek.style.top = "auto";
    peek.style.bottom = (window.innerHeight - limit) + "px";
    peek.style.maxHeight = Math.min(parseFloat(peek.style.maxHeight), limit - m) + "px";
  }
}

// ── Keyboard shortcuts: a map over the page ──
//
// It was a page at the back of the 368px sheet: five groups in a narrow
// column that had to be scrolled, reached through the library. It is now a
// wide panel over the page with the groups side by side and each key drawn
// as a key. The keymap is context-gated (see SHORTCUTS), so the group for
// where the user is standing is lit and labelled: that is the part they came
// for. Chip, "?" and the ⋯ menu open it; esc, × or a click outside close it
// and put the keyboard back where it was.

let keyMapOpen = false;
let keyMapReturn = null;

/** Which SHORTCUTS group applies where the user is right now. */
function keyMapHere() {
  const card = document.getElementById("pm-card");
  if (panelOpen) return "In the library";
  if (card && card.contains(document.activeElement)) return "On the card";
  if (slash || composerHasFocus()) return "In the chat box";
  if (cardState !== "idle") return "When a draft is waiting in the pill";
  return "Anywhere on the page";
}

const KEYMAP_HERE_LINE = {
  "Anywhere on the page": "These work wherever you are",
  "In the chat box": "You are in the chat box",
  "When a draft is waiting in the pill": "A draft is waiting in the pill",
  "On the card": "You are on the rewrite card",
  "In the library": "You are in the library",
};

// ── Keys where they act: a tooltip with the keycaps ──
//
// The map lists every key; this teaches them one at a time, on the control
// the key stands for, which is how shortcuts are actually learned. Any of
// our controls with data-pm-tip (and data-pm-key) gets one, in place of a
// native title: that one comes after a second, unstyled, and cannot draw a
// key. 300ms of rest brings it; moving to the next control while one is up
// brings the next at once. Keyboard focus brings it too.

const KEYTIP_DELAY_MS = 300;
const KEYTIP_WARM_MS = 400;   // how long after one closes the next skips the wait
let keytipTimer = null;
let keytipFor = null;
let keytipWarmUntil = 0;

function showKeytip(el) {
  clearTimeout(keytipTimer);
  keytipFor = el;
  let tip = document.getElementById("pm-keytip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "pm-keytip";
    tip.className = "pm-keytip";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);
  }
  const key = el.dataset.pmKey || "";
  tip.innerHTML = `<span>${escHtml(el.dataset.pmTip)}</span>` +
    (key ? `<span class="pm-keytip-keys">${keyCaps(key).map((c) => `<kbd>${escHtml(c)}</kbd>`).join("")}</span>` : "");
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight, m = 8, gap = 6;
  tip.style.left = Math.round(Math.max(m, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - m))) + "px";
  tip.style.top = Math.round(r.top - gap - h >= m ? r.top - gap - h : r.bottom + gap) + "px";
}

function hideKeytip() {
  clearTimeout(keytipTimer);
  const tip = document.getElementById("pm-keytip");
  if (tip && !tip.hidden) { tip.hidden = true; keytipWarmUntil = Date.now() + KEYTIP_WARM_MS; }
  keytipFor = null;
}

document.addEventListener("pointerover", (e) => {
  const el = e.target.closest?.("[data-pm-tip]");
  if (el === keytipFor) return;
  if (!el) { if (keytipFor) hideKeytip(); else clearTimeout(keytipTimer); return; }
  const tip = document.getElementById("pm-keytip");
  const warm = (tip && !tip.hidden) || Date.now() < keytipWarmUntil;
  hideKeytip();
  if (warm) showKeytip(el);
  else { keytipFor = el; keytipTimer = setTimeout(() => el.isConnected && showKeytip(el), KEYTIP_DELAY_MS); }
}, true);
document.addEventListener("focusin", (e) => {
  const el = e.target.closest?.("[data-pm-tip]");
  if (el && el.matches(":focus-visible")) showKeytip(el); else if (keytipFor) hideKeytip();
}, true);
// Anything the user does next makes the tip old news.
for (const type of ["pointerdown", "keydown", "wheel"]) {
  document.addEventListener(type, () => { if (keytipFor || document.getElementById("pm-keytip")?.hidden === false) hideKeytip(); }, { capture: true, passive: true });
}

/** A chord as the keys it is pressed with: ⌘⇧E is three keys, Ctrl+Shift+E too,
 *  and ⌘⇧Space is three as well: each glyph a key, the named key one. */
function keyCaps(key) {
  if (key.length > 1 && key.includes("+")) return key.split("+").filter(Boolean);
  const glyphs = /^[⌘⇧⌥⌃]+/.exec(key);
  if (glyphs) return [...Array.from(glyphs[0]), key.slice(glyphs[0].length)].filter(Boolean);
  return [key];
}

function keyMapHtml(here) {
  const cap = (k) => keyCaps(k).map((c) => `<kbd class="pm-kb">${escHtml(c)}</kbd>`).join("");
  const chord = (keys) => keys.map(cap).join('<span class="pm-kb-gap"></span>');
  const row = (r) => {
    // The rewrite key is Chrome's to assign, and it may have gone to another
    // extension: the map must not promise a key that does nothing.
    const unset = r.keys[0] === `${MOD_SHIFT}E` && assignedShortcut === "";
    return `<div class="pm-kb-row${unset ? " pm-kb-unset" : ""}"><span class="pm-kb-what">${escHtml(r.what)}` +
      (unset ? `<span class="pm-kb-note">Not set: another extension has this key. Change it below.</span>`
        : r.note ? `<span class="pm-kb-note">${escHtml(r.note)}</span>` : "") +
      `</span><span class="pm-kb-keys">${unset ? `<span class="pm-kb-none">not set</span>` : chord(r.keys)}</span></div>`;
  };
  const group = (g) => {
    const on = g.where === here;
    return `<section class="pm-kb-group${on ? " pm-kb-here" : ""}"${on ? ' aria-current="true"' : ""}>` +
      `<div class="pm-kb-cap"><span>${escHtml(g.where)}</span>${on ? "<em>you are here</em>" : ""}</div>` +
      g.rows.map(row).join("") + `</section>`;
  };
  return `<div class="pm-keys-head"><div><div class="pm-keys-title" id="pm-keys-title">Keyboard shortcuts</div>` +
    `<div class="pm-keys-here">${escHtml(KEYMAP_HERE_LINE[here] || "")}</div></div>` +
    `<button type="button" class="pm-lib-icon" data-act="close" aria-label="Close the shortcuts" data-pm-tip="Close" data-pm-key="Esc">${LIB_ICON.close}</button></div>` +
    `<div class="pm-keys-grid">${SHORTCUTS().map(group).join("")}</div>` +
    // The two Chrome-level commands are the user's to rebind, and a content
    // script cannot link to chrome:// — a link there does nothing when
    // clicked. So the address is text they can copy, on its own line: a
    // broken address is one a reader cannot check.
    `<div class="pm-keys-foot"><p>${escHtml(`${MOD_SHIFT}E`)} and ${escHtml(VOICE_KEY)} are Chrome shortcuts. If another app has taken one, change it here:</p>` +
    `<div class="pm-kb-urlrow"><code class="pm-kb-url">chrome://extensions/shortcuts</code>` +
    `<button type="button" class="pm-kb-copy" data-act="copyshortcuts">Copy</button></div></div>`;
}

function openKeyMap() {
  if (keyMapOpen) { document.querySelector("#pm-keys [data-act='close']")?.focus({ preventScroll: true }); return; }
  const here = keyMapHere();
  keyMapReturn = document.activeElement;
  keyMapOpen = true;
  const scrim = document.createElement("div");
  scrim.id = "pm-keys";
  scrim.className = "pm-keys-scrim";
  scrim.innerHTML = `<div class="pm-lib pm-keys" role="dialog" aria-modal="true" aria-labelledby="pm-keys-title">${keyMapHtml(here)}</div>`;
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim) { closeKeyMap(); return; }
    const act = e.target.closest("button")?.dataset.act;
    if (act === "close") closeKeyMap();
    else if (act === "copyshortcuts") {
      navigator.clipboard?.writeText("chrome://extensions/shortcuts").then(
        () => showToast("Address copied — paste it in a new tab.", "success"),
        () => showToast("Could not copy. The address is chrome://extensions/shortcuts", "info"),
      );
    }
  });
  scrim.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeKeyMap(); }
  });
  document.body.appendChild(scrim);
  requestAnimationFrame(() => scrim.classList.add("pm-keys-in"));
  scrim.querySelector("[data-act='close']")?.focus({ preventScroll: true });
  // Whether Chrome gave the rewrite its key: the row says so if it did not.
  if (assignedShortcut === null) loadShortcut().then(() => {
    const box = document.querySelector("#pm-keys .pm-keys");
    if (box && keyMapOpen) {
      const focused = box.contains(document.activeElement) ? document.activeElement.dataset.act : null;
      box.innerHTML = keyMapHtml(here);
      if (focused) box.querySelector(`[data-act='${focused}']`)?.focus({ preventScroll: true });
    }
  });
  syncHelpChipExpanded();
}

function closeKeyMap() {
  if (!keyMapOpen) return;
  keyMapOpen = false;
  document.getElementById("pm-keys")?.remove();
  syncHelpChipExpanded();
  if (keyMapReturn?.isConnected) keyMapReturn.focus({ preventScroll: true });
  keyMapReturn = null;
}

// ── Feedback, now a page of the sheet ──

async function sendLibraryFeedback() {
  const type = document.getElementById("pm-feedback-type")?.value || "general";
  const message = document.getElementById("pm-feedback-message")?.value.trim() || "";
  const email = document.getElementById("pm-feedback-email")?.value.trim() || "";
  if (message.length < 5) { setStatus("pm-feedback-status", "Write at least a few words.", "error"); return; }
  const btn = document.getElementById("pm-feedback-submit");
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  const ok = await submitFeedback(type, message, email);
  if (btn) { btn.disabled = false; btn.textContent = "Send"; }
  if (ok) {
    setStatus("pm-feedback-status", "Sent. Thank you.", "success");
    const m = document.getElementById("pm-feedback-message");
    if (m) m.value = "";
    loadRecentFeedback();
  } else {
    setStatus("pm-feedback-status", "Could not send. Are you signed in?", "error");
  }
}

function loadRecentFeedback() {
  const box = document.getElementById("pm-feedback-recent");
  if (!box) return;
  fetchMyFeedback().then((items) => {
    const el = document.getElementById("pm-feedback-recent");
    if (!el) return;
    if (!items.length) { el.innerHTML = ""; return; }
    const status = { new: "received", reviewed: "read", resolved: "resolved" };
    el.innerHTML = `<div class="pm-lib-menu-cap">Recent</div>` + items.slice(0, 3).map((it) =>
      `<div class="pm-lib-feedback-item"><span>${escHtml(it.message)}</span>` +
      `<span>${status[it.status] || "received"}${it.timestamp ? " · " + getTimeAgo(it.timestamp) : ""}</span></div>`).join("");
    // It arrives after the page was drawn and can make the page scroll.
    const page = el.closest(".pm-lib-page");
    watchScrollable(page);
    markScrollable(page);
  });
}

// ── Context: attached prompts, kept for the browser session ──

const ATTACH_KEY = "pm_attached";

function saveAttachments() {
  const list = [...selectedIds].map((id) => ({ id, title: attachTitles.get(id) || "" }));
  draftStore.area().then((area) => area.set({ [ATTACH_KEY]: list })).catch(() => {});
}

function applyAttachments(list) {
  selectedIds = new Set();
  attachTitles.clear();
  (Array.isArray(list) ? list : []).forEach((a) => {
    if (a && a.id != null) { selectedIds.add(a.id); attachTitles.set(a.id, a.title || ""); }
  });
  renderRail();
  renderChipCount();
  if (panelOpen) renderLibraryList();
}

async function restoreAttachments() {
  try {
    const area = await draftStore.area();
    const { [ATTACH_KEY]: list } = await area.get(ATTACH_KEY);
    applyAttachments(list);
  } catch { /* nothing attached */ }
}

function toggleAttachment(p) {
  if (selectedIds.has(p.id)) {
    selectedIds.delete(p.id);
    attachTitles.delete(p.id);
  } else {
    selectedIds.add(p.id);
    attachTitles.set(p.id, p.content ? promptTitle(p) : attachTitles.get(p.id) || "");
  }
  saveAttachments();
  renderRail();
  renderChipCount();
  if (panelOpen) renderLibraryList();
}

function clearAttachments() {
  selectedIds.clear();
  attachTitles.clear();
  saveAttachments();
  renderRail();
  renderChipCount();
  if (panelOpen) renderLibraryList();
}

/** After a fetch: forget attachments whose prompt was deleted, refresh titles. */
function reconcileAttachments() {
  if (!selectedIds.size) return;
  const byId = new Map(savedPrompts.map((p) => [p.id, p]));
  let changed = false;
  for (const id of [...selectedIds]) {
    const p = byId.get(id);
    if (!p) { selectedIds.delete(id); attachTitles.delete(id); changed = true; continue; }
    const t = promptTitle(p);
    if (attachTitles.get(id) !== t) { attachTitles.set(id, t); changed = true; }
  }
  if (changed) { saveAttachments(); renderRail(); renderChipCount(); }
}

function renderChipCount() {
  renderPill();   // ⊕ counts the context it will use
  const cnt = document.querySelector("#pm-library-btn .pm-library-count");
  if (!cnt) return;
  cnt.textContent = selectedIds.size ? String(selectedIds.size) : "";
  cnt.hidden = !selectedIds.size;
}

/**
 * The chat box as the user sees it: the rounded frame around the editable
 * element, not the element itself. Hosts pad the text inside that frame, so
 * anchoring to the editable left chips sitting on the frame's border and let
 * the sheet reach down over the send button. The frame is the nearest
 * ancestor, a few levels up at most, that is barely larger than the editable
 * and visibly drawn (a background, a border or rounded corners).
 */
function composerFrame(el) {
  return composerFrameBox(el)?.rect || null;
}

/** composerFrame(), with the element that draws it. */
function composerFrameBox(el) {
  if (!el) return null;
  const inner = el.getBoundingClientRect();
  let box = { node: el, rect: inner };
  let node = el.parentElement;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    const r = node.getBoundingClientRect();
    // Much taller than the text is the page around the box. Much wider is
    // too, unless it is little taller: then it is the box's own row with its
    // controls beside the text, as ChatGPT has had since October 2026 (model
    // picker, mic and Send on the text's row, 254px wider than the text). The
    // frame was taken to end where the text did, and the library, the card
    // and the chips were placed by it, the sheet over the box's Send.
    if (r.height > inner.height + 200 || (r.width > inner.width + 240 && r.height > inner.height + 80)) break;
    const cs = getComputedStyle(node);
    const drawn = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderRadius) >= 8 ||
      (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent");
    if (drawn) box = { node, rect: r };
  }
  return box;
}

/**
 * Where the chat box's own buttons begin, on the side the sheet comes from:
 * the row with Send in it. Buttons level with the text's first line (an
 * expand icon in the corner) do not count; a box whose buttons all sit
 * beside the text has no row below it, and gives null.
 */
function composerControlsTop(el) {
  const box = composerFrameBox(el);
  if (!box || box.node === el) return null;
  const text = el.getBoundingClientRect(), frame = box.rect;
  let top = null;
  for (const b of box.node.querySelectorAll("button, [role='button']")) {
    if (el.contains(b)) continue;
    const r = b.getBoundingClientRect();
    if (!r.width || !r.height || r.left + r.width / 2 < frame.left + frame.width * 0.6) continue;
    if (r.top < text.top + 20) continue;
    top = top === null ? r.top : Math.min(top, r.top);
  }
  return top;
}

/**
 * The rail: attached prompts as chips on the chat box's top edge.
 *
 * It names them on the thing about to be sent, rather than counting them in a
 * panel the user has closed. It steps aside while the rewrite card is open,
 * because the card sits on that same edge, and when the chat box is too near
 * the top of the window to leave room above it.
 */
let railShown = new Set();     // ids on the rail at its last draw, to animate only newcomers

function renderRail() {
  let rail = document.getElementById("pm-rail");
  if (!selectedIds.size) { rail?.remove(); railShown = new Set(); return; }
  if (!rail) {
    rail = document.createElement("div");
    rail.id = "pm-rail";
    rail.className = "pm-rail";
    rail.setAttribute("role", "group");
    rail.setAttribute("aria-label", "Context for your next rewrite");
    rail.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.detach !== undefined) {
        toggleAttachment({ id: [...selectedIds].find((id) => String(id) === b.dataset.detach) });
      } else if (b.dataset.act === "railadd") {
        togglePanel(true);
      }
    });
    document.body.appendChild(rail);
  }
  // Led by what the chips are for. They sit on the chat box, right over what
  // is about to be sent, and read as if they were going with the message;
  // they shape the ⊕ rewrite and are not sent on their own.
  rail.innerHTML = `<span class="pm-rail-label" title="These saved prompts shape your next rewrite (⊕). They are not sent to the chat on their own.">Context for ⊕</span>` +
    [...selectedIds].map((id) => {
    const title = attachTitles.get(id) || "Saved prompt";
    const fresh = railShown.has(id) ? "" : " pm-rail-new";
    return `<span class="pm-rail-chip${fresh}" title="Context for your next rewrite: ${escHtml(title)}">${LIB_ICON.clip}<span>${escHtml(title)}</span>` +
      `<button type="button" data-detach="${escHtml(String(id))}" aria-label="Detach ${escHtml(title)}">${PILL_X_SVG}</button></span>`;
  }).join("") + `<button type="button" class="pm-rail-add" data-act="railadd" aria-label="Attach another saved prompt">+ Context</button>`;
  railShown = new Set(selectedIds);
  positionRail();
}

function positionRail() {
  const rail = document.getElementById("pm-rail");
  if (!rail) return;
  const r = composerFrame(findComposer());
  const hide = !r || cardExpanded || r.top < 48;
  rail.hidden = hide;
  if (hide) return;
  rail.style.left = Math.max(8, Math.round(r.left)) + "px";
  rail.style.bottom = Math.round(window.innerHeight - r.top + RAIL_GAP) + "px";
  let maxWidth = Math.max(180, Math.round(r.width));
  // The pill steps up onto the box's top corner when it would sit on the box
  // (a draft makes it wide), which is this same row: on Claude the chips ran
  // under it (seen live). They stop short of it and wrap upward instead.
  const pill = document.getElementById("pm-trigger")?.getBoundingClientRect();
  if (pill && pill.bottom > r.top - 40 && pill.top < r.top && pill.left > r.left) {
    maxWidth = Math.min(maxWidth, Math.max(180, Math.round(pill.left - r.left - 8)));
  }
  rail.style.maxWidth = maxWidth + "px";
  fitRailToOneRow(rail);
}

/**
 * While the sheet is open the chips keep to the one row it leaves them, the
 * oldest folding into a "+2" chip; wrapping upward ran them under the sheet.
 * The newest stays in view: it is the one the user just watched land.
 */
function fitRailToOneRow(rail) {
  const chips = [...rail.querySelectorAll(".pm-rail-chip")];
  chips.forEach((c) => { c.hidden = false; });
  rail.querySelector(".pm-rail-more")?.remove();
  rail.classList.toggle("pm-rail-one", panelOpen);
  if (!panelOpen) return;
  const max = parseFloat(rail.style.maxWidth) || Infinity;
  let folded = 0;
  while (rail.scrollWidth > max + 1 && folded < chips.length - 1) {
    chips[folded].hidden = true;
    folded++;
    let more = rail.querySelector(".pm-rail-more");
    if (!more) {
      more = document.createElement("span");
      more.className = "pm-rail-more";
      rail.insertBefore(more, chips[0]);
    }
    more.textContent = "+" + folded;
    more.title = chips.slice(0, folded).map((c) => c.textContent.trim()).join(", ");
  }
}

// ── // in the chat box ──
//
// Typing // after a space or at the start of a line opens the saved prompts at
// the caret, filtered by what follows (//bug). ↵ puts the prompt where the //
// was, ⇥ attaches it as context instead, esc leaves the text exactly as typed.
// A URL (https://) or a//b never opens it: the // must start a word.

let slash = null;          // { el, node, start, end, q } while open
let slashMuted = false;    // esc pressed: stay shut until this // is gone
let slashSel = 0;
let slashFetching = false;

const SLASH_TOKEN = /(^|\s)\/\/([^\s/]*)$/;

function isTextField(el) {
  return el.tagName === "TEXTAREA" || el.tagName === "INPUT";
}

/** The text before the caret in the composer, and where it lives. */
function slashContext(el) {
  if (isTextField(el)) {
    const end = el.selectionStart;
    if (end == null || el.selectionEnd !== end) return null;
    return { node: null, text: el.value.slice(0, end), offset: end };
  }
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed || !el.contains(sel.focusNode)) return null;
  // The token is matched in the caret's own text node: a range over the whole
  // editor runs paragraphs together with no separator, so // at the start of a
  // new line would read as the end of the previous word.
  if (sel.focusNode.nodeType !== Node.TEXT_NODE) return null;
  return { node: sel.focusNode, text: sel.focusNode.data.slice(0, sel.focusOffset), offset: sel.focusOffset };
}

function checkSlash() {
  const el = findComposer();
  if (!el || !slashEnabled || !libSignedIn || !dataConsent || panelOpen) { closeSlash(); return; }
  const ctx = slashContext(el);
  const m = ctx && ctx.text.match(SLASH_TOKEN);
  if (!m) { slashMuted = false; closeSlash(); return; }
  if (slashMuted) return;
  const q = m[2];
  if (!slash || slash.q !== q) slashSel = 0;
  slash = { el, node: ctx.node, start: ctx.offset - q.length - 2, end: ctx.offset, q };
  if (!promptsLoaded && !slashFetching) {
    slashFetching = true;
    fetchSavedPrompts().finally(() => { slashFetching = false; if (slash) renderSlash(); });
  }
  renderSlash();
}

function slashItems() {
  if (!slash) return [];
  const q = slash.q.toLowerCase();
  // Every match: the list scrolls. It used to stop at six, and a seventh
  // prompt could only be reached by typing enough of it to filter the rest out.
  return savedPrompts
    .filter((p) => !q || [p.title, p.content, ...(p.tags || [])].join(" ").toLowerCase().includes(q.replace(/^#/, "")));
}

function closeSlash() {
  slash = null;
  document.getElementById("pm-caret")?.remove();
}

function caretRect(el) {
  if (!isTextField(el)) {
    const sel = window.getSelection();
    if (sel.rangeCount) {
      const range = sel.getRangeAt(0).cloneRange();
      range.collapse(true);
      const rect = range.getClientRects()[0];
      if (rect && (rect.width || rect.height)) return rect;
      const parent = sel.focusNode?.parentElement;
      if (parent && el.contains(parent)) return parent.getBoundingClientRect();
    }
  }
  const r = el.getBoundingClientRect();
  return { left: r.left + 12, top: r.top + 8, bottom: r.top + 28 };
}

function renderSlash() {
  if (!slash) return;
  let menu = document.getElementById("pm-caret");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "pm-caret";
    menu.className = "pm-caret";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "Saved prompts");
    // Keep the caret in the chat box: a click here must not take focus away.
    menu.addEventListener("mousedown", (e) => e.preventDefault());
    menu.addEventListener("click", (e) => {
      const row = e.target.closest("[data-i]");
      if (!row) return;
      slashSel = Number(row.dataset.i);
      if (e.target.closest("[data-act='attach']")) slashAttach(); else slashInsert();
    });
    document.body.appendChild(menu);
    // The rewrite card sits on the chat box, which is exactly where this menu
    // opens, and typing // has just made its draft stale: the text no longer
    // matches what was rewritten. It folds into the pill, as esc would fold
    // it, rather than have a menu drawn across its text and buttons. The pill
    // keeps the draft and offers Redo (or Insert again, if the // is deleted
    // and the text matches once more). It does not spring back when the menu
    // closes: the user is mid-sentence.
    if (cardExpanded) hideCard();
  }
  const items = slashItems();
  slashSel = Math.max(0, Math.min(slashSel, items.length - 1));
  // Redrawn on every keystroke and caret move. A list the user has scrolled
  // keeps its place while the query is the same; a new query starts at the top.
  const oldList = menu.querySelector(".pm-caret-list");
  const sameList = Boolean(oldList) && menu.dataset.q === slash.q;
  const keepTop = sameList ? oldList.scrollTop : 0;
  const moved = !sameList || menu.dataset.sel !== String(slashSel);
  menu.dataset.q = slash.q;
  menu.dataset.sel = String(slashSel);
  const count = promptsLoaded && items.length > 1 ? `<i>${items.length}</i>` : "";
  const head = `<div class="pm-caret-head"><b>//${escHtml(slash.q)}${count}</b><span>${ENTER_KEY} insert · ${TAB_KEY} attach · esc</span></div>`;
  let body;
  if (!promptsLoaded) body = `<div class="pm-caret-empty">Loading your saved prompts…</div>`;
  else if (!items.length) body = `<div class="pm-caret-empty">${savedPrompts.length ? `No saved prompt matches “${escHtml(slash.q)}”` : "No saved prompts yet. Open the library to save one."}</div>`;
  else body = items.map((p, i) => {
    const att = selectedIds.has(p.id);
    return `<div class="pm-caret-row${i === slashSel ? " pm-sel" : ""}${att ? " pm-att" : ""}" data-i="${i}" role="option" aria-selected="${i === slashSel}">` +
      `<div class="pm-lib-text"><div class="pm-lib-title">${escHtml(promptTitle(p))}</div>` +
      (i === slashSel ? `<div class="pm-lib-preview">${escHtml(promptPreview(p))}</div>` : "") + `</div>` +
      `<button type="button" class="pm-lib-icon pm-lib-attach" data-act="attach" aria-pressed="${att}" tabindex="-1" aria-label="Attach as context">${LIB_ICON.clip}</button></div>`;
  }).join("");
  menu.innerHTML = head + `<div class="pm-caret-list">${body}</div>`;
  placeSlash();
  const list = menu.querySelector(".pm-caret-list");
  list.scrollTop = keepTop;
  // ↑↓ can walk past the fold; the highlight follows into view, as in the
  // sheet. Only when it moved: a redraw for a caret move must not undo a
  // scroll the user just made with the wheel.
  if (moved) list.querySelector(".pm-caret-row.pm-sel")?.scrollIntoView({ block: "nearest" });
}

/**
 * Put the menu by the caret, without redrawing it.
 *
 * Separate from renderSlash() so a page scroll only moves the menu. Redrawing
 * on scroll threw the list back to its top: the scroll listener is on window
 * in the capture phase, so it also heard the menu's own list scrolling, and
 * every turn of the wheel reset it.
 */
function placeSlash() {
  const menu = document.getElementById("pm-caret");
  if (!slash || !menu) return;
  const rect = caretRect(slash.el);
  const width = Math.min(340, window.innerWidth - 24);
  menu.style.width = width + "px";
  menu.style.left = Math.max(12, Math.min(rect.left - 12, window.innerWidth - width - 12)) + "px";
  if (rect.top > 240) {
    menu.style.top = "auto";
    menu.style.bottom = Math.round(window.innerHeight - rect.top + 8) + "px";
  } else {
    menu.style.bottom = "auto";
    menu.style.top = Math.round(rect.bottom + 8) + "px";
  }
}

/**
 * Where the //query is now. The position noted when the menu opened can be
 * stale by the time a prompt is chosen: an editor that re-renders on every
 * transaction may have replaced the text node it pointed into. The caret has
 * not moved (the menu keeps focus in the chat box), so it is read again.
 */
function refreshSlashToken(s) {
  const ctx = slashContext(s.el);
  const m = ctx && ctx.text.match(SLASH_TOKEN);
  if (!m || m[2] !== s.q) return s;
  return { ...s, node: ctx.node, start: ctx.offset - s.q.length - 2, end: ctx.offset };
}

/** Select the //query token in the composer, so the next edit replaces it. */
function selectSlashToken(s) {
  s.el.focus({ preventScroll: true });
  if (isTextField(s.el)) {
    s.el.setSelectionRange(s.start, s.end);
    return true;
  }
  if (!s.node || !s.node.isConnected || s.node.data.length < s.end) return false;
  const range = document.createRange();
  range.setStart(s.node, s.start);
  range.setEnd(s.node, s.end);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

/** Replace the selection the way an editor accepts: beforeinput, then insertText. */
function typeIntoSelection(el, text) {
  const go = el.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true, cancelable: true, inputType: text ? "insertText" : "deleteContentBackward", data: text || null,
  }));
  if (go) document.execCommand(text ? "insertText" : "delete", false, text || undefined);
}

async function slashInsert() {
  const p = slashItems()[slashSel];
  const s = slash && refreshSlashToken(slash);
  if (!s || !p) return;
  closeSlash();
  const before = composerText(s.el);
  const token = "//" + s.q;
  // What the whole box should read afterwards, for checking and as a fallback.
  const idx = before.lastIndexOf(token);
  const lead = idx > 0 && !/\s$/.test(before.slice(0, idx)) ? " " : "";
  const expected = idx >= 0 ? before.slice(0, idx) + lead + p.content + before.slice(idx + token.length) : null;
  if (selectSlashToken(s)) typeIntoSelection(s.el, p.content);
  await nextFrame();
  const after = composerText(s.el);
  const landed = norm(after).includes(norm(p.content)) && !norm(after).includes(norm(token));
  if (!landed && expected !== null) await applyOrFallback(expected, null);
  showApplied(null);
  statsBump("slash");
  tipDone("slash");
}

function slashAttach() {
  const p = slashItems()[slashSel];
  const s = slash && refreshSlashToken(slash);
  if (!s || !p) return;
  closeSlash();
  if (!selectedIds.has(p.id)) toggleAttachment(p);
  // The //query was a way to find the prompt, not text to send.
  if (selectSlashToken(s)) typeIntoSelection(s.el, "");
}

function handleSlashKeydown(e) {
  if (!slash || e.isComposing) return;
  if (e.target !== slash.el && !slash.el.contains(e.target)) return;
  const items = slashItems();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!items.length) return;
    slashSel = (slashSel + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    renderSlash();
  } else if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    // With nothing to pick, Enter is the user's: it sends what they typed.
    // Muted, as esc mutes it: the //query is still at the caret until the
    // host clears the box, and a selectionchange still queued from the typing
    // reopened the menu over a message that had just been sent.
    if (!items.length) { slashMuted = true; closeSlash(); return; }
    slashInsert();
  } else if (e.key === "Tab" && !e.shiftKey) {
    if (!items.length) return;
    slashAttach();
  } else if (e.key === "Escape") {
    slashMuted = true;
    closeSlash();
  } else {
    return;
  }
  // Window capture runs before the host editor and before this script's own
  // document listeners, so Enter here never reaches the host's send, and the
  // passive tracker never records a //query as a sent prompt.
  e.preventDefault();
  e.stopImmediatePropagation();
}

// ── Watching the chat box ──
//
// Most editors fire `input` as the user types. ProseMirror, the editor ChatGPT
// and Claude are built on, does not: it takes each keypress itself and writes
// the text through its own transaction, so no input event ever reaches the
// page. Everything here that reacted to typing listened for `input` — the //
// menu, the rail following the box as it grows, a draft turning stale — and on
// those two sites heard nothing: // never opened, and the Enter meant to pick
// a prompt sent the message instead. A MutationObserver on the composer sees
// every change to its text whoever makes it, and selectionchange sees the
// caret move; `input` stays as the fast path where it does fire.

let watchedComposer = null;
let composerObserver = null;
let composerChangeQueued = false;

/** Observe whatever the composer is now. Cheap to call often. */
function watchComposer() {
  const el = findComposer();
  if (el === watchedComposer) return;
  composerObserver?.disconnect();
  watchedComposer = el;
  if (!el) return;
  composerObserver = new MutationObserver(onComposerChanged);
  composerObserver.observe(el, { subtree: true, childList: true, characterData: true });
}

/**
 * The user went back to typing in the chat box: the library is done with.
 *
 * Only while the chat box has focus, so a change made from code (our own
 * Insert, the host restoring a draft) does not count as the user leaving.
 */
function closeLibraryOnTyping() {
  if (panelOpen && composerHasFocus()) togglePanel(false);
}

/** The chat box's text changed. Batched: one keystroke can be many mutations. */
function onComposerChanged() {
  if (composerChangeQueued) return;
  composerChangeQueued = true;
  Promise.resolve().then(() => {
    composerChangeQueued = false;
    closeLibraryOnTyping();
    checkSlash();
    refreshCardStaleness();
    positionRail();
    tipsOnComposerChanged();
    renderPill();   // "⊕ Improve" appears with a draft, and goes when it is sent
  });
}

function setupLibraryListeners() {
  window.addEventListener("keydown", handleSlashKeydown, true);
  document.addEventListener("input", (e) => {
    const composer = findComposer();
    if (composer && (e.target === composer || composer.contains(e.target))) {
      closeLibraryOnTyping();
      checkSlash();
      requestAnimationFrame(positionRail);
      // A <textarea> composer changes its value, not its DOM, so the
      // MutationObserver never fires for it: the tips and the pill hear typing here too.
      tipsOnComposerChanged();
      renderPill();
    }
  }, true);
  // The caret moving (a click, an arrow key) opens or closes // too, and it is
  // the one signal every editor gives.
  document.addEventListener("selectionchange", () => {
    if (slash || composerHasFocus()) checkSlash();
  });
  document.addEventListener("focusin", watchComposer, true);
  watchComposer();
  document.addEventListener("focusout", (e) => {
    if (slash && (e.target === slash.el || slash.el.contains(e.target))) setTimeout(() => {
      if (slash && !slash.el.contains(document.activeElement) && document.activeElement !== slash.el) closeSlash();
    }, 0);
  }, true);
  // Capture phase: a scroll anywhere, the page's or a panel's, may have moved
  // the chat box. The menu's own list scrolling is not one of those.
  window.addEventListener("scroll", (e) => {
    if (e.target instanceof Element && e.target.closest("#pm-caret")) return;
    positionRail();
    placeSlash();
  }, true);
  window.addEventListener("resize", () => { positionRail(); positionLibrary(); closeSlash(); });

  // Sign-in state and attachments can change in another tab or the popup.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (changes.token && area === "local") {
        const t = changes.token.newValue;
        libSignedIn = Boolean(t && !isTokenExpired(t));
        promptsLoaded = false;
      }
      // Signed out, or someone else signed in: the attachments are not theirs.
      // Keyed on the user, not the token, which refreshes itself for the same
      // user every few days and must not wipe what they attached.
      const signedOut = changes.token && area === "local" && changes.token.oldValue && !changes.token.newValue;
      const otherUser = changes.user_id && area === "local" && changes.user_id.oldValue &&
        changes.user_id.newValue !== changes.user_id.oldValue;
      if (signedOut || otherUser) {
        savedPrompts = [];
        clearAttachments();
      }
      if (changes[ATTACH_KEY]) applyAttachments(changes[ATTACH_KEY].newValue);
    });
  } catch (error) { onOrphaned(error); }

  getAuth().then((auth) => { libSignedIn = Boolean(auth && !isTokenExpired(auth.token)); });
  restoreAttachments();
}

// ══════════════════════════════════════════════════════════════
// USAGE COUNTER
// ══════════════════════════════════════════════════════════════

async function fetchUsage() {
  try {
    // /enhance rations on effective_tier(), which promotes a request carrying
    // the user's own key to the byok tier. This endpoint had no way to know
    // that and reported the free-tier limit, so a BYOK user watched a "12/15"
    // bar fill up while the server was actually allowing them 1,000.
    const route = await askWorker({ type: "PM_GET_ROUTE" });
    const qs = route?.hasKey ? "?byok=true" : "";
    const res = await authedFetch(`${API_URL}/enhance/usage${qs}`);
    if (!res) return;
    const data = await res.json();
    usageData = { count: data.count || 0, limit: data.limit || 30 };
    updateUsageBar();
  } catch (e) {
    console.log("Prompt Memory: usage fetch skipped", e);
  }
}

/**
 * The count is known now. The library shows it only where it decides
 * something: a footer line with three or fewer left, and a line in ⋯. It used
 * to be a bar on screen at every level, which added worry and no decision.
 */
function updateUsageBar() {
  usageData.known = true;
  if (panelOpen) renderLibraryList();
}

// ══════════════════════════════════════════════════════════════
// SCROLL HINTS
// ══════════════════════════════════════════════════════════════

/**
 * Mark a scroller that has more content below it.
 *
 * Both scrolling surfaces cut their last row dead: the saved-prompt list ended
 * in an item sliced through the middle against the panel footer, and the card's
 * rewrite ended mid-line. A clean edge with nothing beyond it reads as broken
 * rather than as "keep going" — the cut looks like a rendering fault, not an
 * invitation.
 *
 * The fade is a mask on the scroller itself, which stays put while the content
 * moves under it, and it is removed at the bottom so the last line is never
 * dimmed once there is genuinely nothing more to see.
 */
function markScrollable(el) {
  if (!el) return;
  const more = el.scrollHeight - el.scrollTop - el.clientHeight > 2;
  el.classList.toggle("pm-scroll-more", more);
}

/** Keep the fade honest as the user scrolls. Idempotent per element. */
function watchScrollable(el) {
  if (!el || el.dataset.pmScrollWatched) return;
  el.dataset.pmScrollWatched = "1";
  el.addEventListener("scroll", () => markScrollable(el), { passive: true });
}

function getTimeAgo(isoString) {
  const date = new Date(isoString);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

async function submitFeedback(type, message, email) {
  const body = {
    type,
    message,
    email: email || undefined,
    source: "extension",
    page_url: window.location.href,
    browser_info: `${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || "Chrome"}, ${navigator.platform}`,
  };
  const res = await authedFetch(`${API_URL}/feedback`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return res && res.ok;
}

async function fetchMyFeedback() {
  const res = await authedFetch(`${API_URL}/feedback/mine`);
  if (res && res.ok) {
    const data = await res.json();
    return data.feedback || [];
  }
  return [];
}

// ══════════════════════════════════════════════════════════════
// ENHANCE HANDLER (streaming)
// ══════════════════════════════════════════════════════════════

/** Open the extension's own settings UI. */
/** Open the settings page; `section` ("key" or "signin") opens it at that step. */
function openSettings(section = "") {
  if (orphaned || !extensionAlive()) { onOrphaned(); return; }
  try {
    chrome.runtime.sendMessage({ type: "PM_OPEN_OPTIONS", section }, () => {
      if (!extensionAlive()) { onOrphaned(); return; }
      if (chrome.runtime.lastError) {
        showToast("Click the Prompt Memory icon in your toolbar to open settings.", "info");
      }
    });
  } catch (e) { onOrphaned(e); }
}

// Guards against a second enhancement starting while one is in flight. Two
// concurrent streams wrote into the same modal and the same composer, and on
// the shared key that burned two of a user's fifteen daily enhancements for
// one result.
let enhanceInFlight = false;

/**
 * With a draft pending, the ⊕ shows it rather than starting over.
 *
 * Unless the composer holds NEW text — different from what the draft was built
 * from — in which case the user has moved on and wants that enhanced. An empty
 * or unchanged box means "show me what you have". This is what keeps a click
 * on the pill from spending one of fifteen daily enhancements on the same
 * sentence twice.
 */
function reopenDraftIfRelevant(reveal = false) {
  if (cardState === "idle") return false;
  // An Improve draft is not about the chat box, so new text there does not
  // replace it: ⊕ shows it until it is used or discarded.
  if (cardState === "ready" && !cardSubject) {
    const now = norm(getCurrentInputText());
    if (now && now !== cardBasedOn) return false;
  }
  if (reveal) revealCard();
  else toggleCard();
  return true;
}

/**
 * Bring the draft's card up, and never put it away.
 *
 * The keyboard shortcut used to go through toggleCard(), so pressing it again
 * on the same draft hid the card it had just shown: one press rewrote, the next
 * made the rewrite vanish, and testers reported the shortcut as broken. The
 * pill still folds the card on click (it is the card's handle), and ⌘⇧P is
 * the explicit toggle; the shortcut only ever shows.
 */
function revealCard() {
  if (!cardExpanded) { expandCard(); return; }
  if (cardTucked) { untuckCard(); return; }
  const card = document.getElementById("pm-card");
  if (card) {
    card.classList.remove("pm-card-nudge");
    void card.offsetWidth;   // restart the animation
    card.classList.add("pm-card-nudge");
  }
  if (cardState === "ready") showToast("Already rewritten. Change the text in the chat box to rewrite it again.", "info");
}

/**
 * Ask the service worker how an enhancement should be routed, or explain why
 * it cannot run. Resolves to the route, or null once the user has been told.
 * Shared by ⊕ and by the card's style buttons, which must fail the same way.
 */
async function resolveEnhanceRoute() {
  if (!(await ensureDataConsent())) return null;
  // Ask the service worker how this request should be routed. It owns the API
  // key, so the decision cannot be made here.
  const route = await askWorker({ type: "PM_GET_ROUTE" });
  if (orphaned) return null;
  if (!route) {
    // The worker is unreachable. Almost always this tab's content script was
    // orphaned by an extension update or reload — the page needs refreshing,
    // which is a different problem from "you have not set anything up yet".
    showToast("Prompt Memory was updated — please reload this page.", "error");
    return null;
  }
  if (route.route === "expired") {
    // Signed in at some point, token past its 7-day life, and no API key to
    // fall back on. Previously this routed at the backend anyway and produced
    // an unexplained failure on every attempt.
    showToast("Your session expired — please sign in again.", "error");
    openSettings();
    return null;
  }
  if (route.route === "none") {
    // Neither signed in nor holding a key. Previously this said "Please log in
    // first" and stopped — the extension delivered nothing at all until the
    // user completed a Google OAuth flow. Now there are two ways forward and
    // the faster one needs no account.
    showSetupRequiredModal();
    return null;
  }
  return route;
}

/** `reveal`: the keyboard shortcut, which shows a pending draft but never hides it. */
async function handleEnhance({ reveal = false } = {}) {
  if (orphaned || !extensionAlive()) {
    onOrphaned();
    return;
  }
  if (enhanceInFlight) {
    if (reveal && cardState === "streaming") revealCard();
    else showToast("Already enhancing — hang on a moment.", "info");
    return;
  }
  if (reopenDraftIfRelevant(reveal)) return;

  const inputText = getCurrentInputText();
  if (!inputText || inputText.trim().length < 3) {
    showToast("Type a prompt in the chat input first.", "error");
    return;
  }
  const route = await resolveEnhanceRoute();
  if (!route) return;

  enhanceInFlight = true;
  showStreamingDiffModal(inputText);

  try {
    if (route.route === "direct") {
      await runDirectEnhance(inputText, route);
    } else {
      await runBackendEnhance(inputText);
    }
  } catch (err) {
    console.error("Prompt Memory: enhance failed", err);
    failStreamingModal(err?.message || "Enhancement failed. Please try again.");
  } finally {
    enhanceInFlight = false;
  }
}

/** No account, no server: the service worker calls the user's own provider. */
async function runDirectEnhance(inputText, route, style = currentMode) {
  return new Promise((resolve) => {
    let port;
    try {
      if (!extensionAlive()) throw new Error("Extension context invalidated");
      port = chrome.runtime.connect({ name: "pm-stream" });
      if (!port?.onMessage || !port?.onDisconnect) throw new Error("Extension context invalidated");
    } catch (e) {
      onOrphaned(e);
      resolve();
      return;
    }
    let parts = [];
    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch { /* already closed */ }
      fn();
      resolve();
    };
    cancelActiveStream = () => finish(() => {});

    port.onMessage.addListener((msg) => {
      if (msg.type === "token") {
        parts.push(msg.token);
        updateStreamingText(parts.join(""));
      } else if (msg.type === "done") {
        finish(() => {
          lastEnhanceResult = {
            original: inputText,
            enhanced: msg.enhanced,
            log_id: null,          // nothing is logged in direct mode
            latency: null,
            mode: style,
            direct: true,
            model: msg.model,
          };
          finalizeStreamingModal(lastEnhanceResult);
        });
      } else if (msg.type === "error") {
        finish(() => failStreamingModal(msg.error));
      }
    });

    // If the worker dies mid-flight the modal must not spin forever.
    port.onDisconnect.addListener(() => {
      finish(() => failStreamingModal("Connection to the extension worker was lost."));
    });

    port.postMessage({ type: "PM_ENHANCE_STREAM", prompt: inputText, mode: style });
  });
}

/** Signed in: go through the backend so memory features still apply. */
async function runBackendEnhance(inputText, inputMetadata = {}, style = currentMode) {
  let parts = [];
  let finished = false;

  await enhancePromptStream(
    inputText,
    Array.from(selectedIds),
    (token) => {
      parts.push(token);
      updateStreamingText(parts.join(""));
    },
    (metadata) => {
      finished = true;
      // The backend now reports failure explicitly. Without this check a dead
      // model produced an empty stream, a done event, and a modal that
      // cheerfully presented nothing as the finished enhancement.
      if (metadata.failed || !parts.length) {
        failStreamingModal(
          metadata.detail || metadata.error ||
          "The enhancement came back empty. Please try again."
        );
        return;
      }
      // The count first: the card that finalize draws labels its style
      // buttons with how many rewrites are left, and drawn before this it
      // was always one rewrite behind — blank on the first of the day.
      if (metadata.usage_today) {
        usageData.count = metadata.usage_today.used;
        usageData.limit = metadata.usage_today.limit;
      } else {
        usageData.count++;
      }
      updateUsageBar();

      // context_details names each saved prompt that shaped the rewrite. It
      // was dropped here, so the card could only ever say "3 saved prompts
      // used" and never which ones, though the server has sent them since
      // the streaming route learned to (7725aef).
      lastEnhanceResult = {
        original: inputText,
        enhanced: parts.join(""),
        log_id: metadata.log_id,
        latency: metadata.latency,
        mode: metadata.mode || style,
        model: metadata.model,
        context_used: metadata.context_used,
        context_details: metadata.context_details,
        excluded: inputMetadata.excluded || [],
      };
      finalizeStreamingModal(lastEnhanceResult);
    },
    inputMetadata,
    style
  );

  // enhancePromptStream returns without ever invoking onDone if the request
  // itself threw. Leaving the modal on "Enhancing..." forever was the visible
  // symptom of every backend outage.
  if (!finished) {
    failStreamingModal("Could not reach the server. Check your connection and try again.");
  }
}

/** Ask the service worker something; resolves to null if it is unreachable. */
function askWorker(message) {
  return new Promise((resolve) => {
    if (orphaned || !extensionAlive()) { onOrphaned(); resolve(null); return; }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (!extensionAlive()) { onOrphaned(); resolve(null); return; }
        if (chrome.runtime.lastError) {
          console.warn("Prompt Memory: worker unreachable", chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response);
      });
    } catch (e) {
      onOrphaned(e);
      resolve(null);
    }
  });
}

// ══════════════════════════════════════════════════════════════
// STREAMING DIFF MODAL — Shows tokens arriving in real-time
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// INLINE REWRITE CARD
// ══════════════════════════════════════════════════════════════
//
// This replaces the diff modal for the whole enhance flow. The modal blacked
// out the conversation to present a three-line rewrite, spent half its area
// echoing back the prompt the user typed four seconds earlier, and offered
// four buttons (Discard / Copy / Save / Use This Prompt) for what is a binary
// decision — with "Discard" rendering clipped behind "Copy".
//
// The card anchors to the composer instead, so the conversation stays readable
// while you judge a rewrite that is supposed to fit it, and the decision is two
// Explicit buttons insert; Tab navigates; Escape minimizes.
//
// The four entry points below keep the names the streaming flow already calls,
// so runBackendEnhance/runDirectEnhance are untouched.

let cardState = "idle";        // idle | streaming | ready | error
let cardResult = null;
let cardShowingOriginal = false;
let cardOriginal = "";
let cardReposition = null;
let cardHasBaseline = false;
let cardLayout = null;          // { detached, x, y, width, height }

// The composer text this rewrite was actually built from, normalised.
//
// Tracked as TEXT rather than as an "edited" flag on purpose. A flag cannot be
// un-set: undoing an edit would leave the card stranded as stale forever, and a
// stray trailing space would trigger it. Comparing text means undo restores the
// card to fresh for free, and whitespace churn is invisible.
let cardBasedOn = "";
let cardStale = false;
// Whether the card is on screen. The draft can exist without the card: hidden
// in the pill after Esc, or restored from storage on a new page.
let cardExpanded = false;
// The user minimized the card and has not asked for it back. A rewrite that
// finishes while this is set lands in the pill instead of popping the card
// open over what they moved on to.
let cardMinimized = false;
// The card is folded to a one-line strip on the chat box: the user went back
// to reading or clicking in the conversation. Still on screen (cardExpanded
// stays true), still one click from the whole card, and the strip keeps the
// draft's verb. Minimize is the stronger fold, into the pill.
let cardTucked = false;
let cardError = "";
let pillStreamingPreview = "";
// Every rewrite of this draft, one per style asked for, oldest first. The card
// shows cardVersions[cardVersionIndex]; cardResult is always that entry.
let cardVersions = [];
let cardVersionIndex = 0;
// Set while a style rerun streams: the versions to go back to if it is
// cancelled or fails. A rerun must never cost the user the draft they had.
let cardRerunFrom = null;
// The style the streaming card is waiting on, for its title.
let cardStreamingStyle = "";
// Whether the list of saved prompts under the rewrite is open. Per draft.
let cardUsedOpen = false;
// Set when the draft improves a saved prompt rather than the chat box text:
// { id, title, content }. Its verb is "Update saved prompt", and the chat box
// has no say in it — it is neither the source nor the destination.
let cardSubject = null;
// Set by whichever stream runner is active; called by closeCard() while
// streaming. Without it "cancel" only hid the card, and the rewrite popped
// back up as a finished draft when the stream it was still running ended.
let cancelActiveStream = null;

function cardLayoutStorageKey() {
  return `pm_card_layout:${window.location.hostname}`;
}

function restoreCardLayout() {
  return new Promise((resolve) => {
    storageGet(cardLayoutStorageKey(), (result) => {
      const saved = result[cardLayoutStorageKey()];
      cardLayout = saved?.detached && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) ? saved : null;
      resolve();
    });
  });
}

function saveCardLayout() {
  if (cardLayout?.detached) {
    storageSet({ [cardLayoutStorageKey()]: cardLayout });
  }
}

function resetCardLayout() {
  cardLayout = null;
  storageSet({ [cardLayoutStorageKey()]: null });
  const card = document.getElementById("pm-card");
  if (!card) return;
  card.classList.remove("pm-card-free");
  card.style.height = "";
  if (document.activeElement?.id === "pm-card-reset") card.querySelector("#pm-card-resize")?.focus({ preventScroll: true });
  positionCard();
  placePill();
}

/**
 * Stale means: the composer holds text that is NOT what this rewrite was built
 * from. An EMPTY composer is not stale — there is nothing in it that accepting
 * could destroy, and an empty box in a fresh chat is precisely where a draft
 * that followed the user is meant to land.
 */
function isStaleAgainstComposer() {
  if (!cardBasedOn || cardSubject) return false;
  const now = norm(getCurrentInputText());
  return now !== "" && now !== cardBasedOn;
}

function getOrCreateCard() {
  let card = document.getElementById("pm-card");
  if (!card) {
    card = document.createElement("div");
    card.id = "pm-card";
    card.className = "pm-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Enhanced prompt");
    document.body.appendChild(card);
    // The card grows as the rewrite streams in. A pill that was clear of it
    // a moment ago may not be now, and only placePill() knows where to go.
    card._pmResize = new ResizeObserver(() => placePill());
    card._pmResize.observe(card);

    storageGet("pm_theme", (r) =>
      card.setAttribute("data-pm-theme", r.pm_theme || "dark")
    );
  }
  return card;
}

/**
 * The card starts attached to the composer. Dragging its title bar or resize
 * grip turns it into a floating workspace, remembered for this site.
 */
function setupCardInteractions(card) {
  const head = card.querySelector(".pm-card-head");
  const grip = card.querySelector(".pm-card-resize");
  // No separate "Layout" button in the title bar: the grip is the one way in.
  // Dragging it resizes; clicking it (or Enter/Space) opens the move and size
  // controls, the non-drag route; arrow keys on it resize. Before, a missing
  // toggle made this return early and silently disabled dragging too.
  if (!head || !grip) return;
  const controls = document.createElement("div");
  controls.id = "pm-card-layout";
  controls.className = "pm-card-layout";
  controls.hidden = true;
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Card position and size");
  const adjustments = {
    Left: [-24, 0, 0, 0], Right: [24, 0, 0, 0],
    Up: [0, -24, 0, 0], Down: [0, 24, 0, 0],
    Narrower: [0, 0, -40, 0], Wider: [0, 0, 40, 0],
    Shorter: [0, 0, 0, -40], Taller: [0, 0, 0, 40],
  };
  const adjust = ([dx, dy, dw, dh]) => {
    const r = card.getBoundingClientRect();
    cardLayout = { detached: true, x: r.left + dx, y: r.top + dy, width: r.width + dw, height: r.height + dh };
    positionCard();
    saveCardLayout();
  };
  for (const [label, delta] of Object.entries(adjustments)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => adjust(delta));
    controls.appendChild(button);
  }
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Reset layout";
  reset.addEventListener("click", resetCardLayout);
  controls.appendChild(reset);
  head.after(controls);
  const toggleLayout = () => {
    controls.hidden = !controls.hidden;
    grip.setAttribute("aria-expanded", String(!controls.hidden));
    positionCard();
  };
  card.querySelector("#pm-card-reset")?.addEventListener("click", resetCardLayout);
  // A pointer press on the grip is captured by the card (so a resize cannot
  // slip off the small grip), which means the click it ends with lands on the
  // card, not here: a mouse click on the grip never reached this handler and
  // opened nothing. A press that ends without moving is therefore handled in
  // end() below, and this handler only answers keyboard clicks (detail 0:
  // Enter or Space on the focused grip).
  grip.addEventListener("click", (e) => {
    if (e.detail !== 0) return;
    toggleLayout();
  });
  grip.addEventListener("keydown", (e) => {
    const delta = { ArrowLeft: [0,0,-12,0], ArrowRight: [0,0,12,0], ArrowUp: [0,0,0,-12], ArrowDown: [0,0,0,12] }[e.key];
    if (!delta) return;
    e.preventDefault();
    adjust(delta.map(value => value * (e.shiftKey ? 3 : 1)));
  });
  const begin = (event, kind) => {
    if (event.button !== 0 || (kind === "move" && event.target.closest("button"))) return;
    card._pmEndGesture?.();
    const r = card.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    let moved = false;
    // Capture before the pointer can leave the small grip. Window listeners
    // still finish the gesture if capture is unavailable or the page blurs.
    try { card.setPointerCapture(event.pointerId); } catch { /* window fallback */ }
    const move = (next) => {
      if (next.pointerId !== event.pointerId) return;
      const dx = next.clientX - start.x, dy = next.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      card.classList.add(kind === "move" ? "pm-card-moving" : "pm-card-resizing");
      if (kind === "resize") {
        const rightBound = window.innerWidth - 12;
        // A resize keeps its top-left corner fixed. The ordinary layout clamp
        // can move the whole card when a requested size passes an edge.
        cardLayout = clampCardResize(r, dx, dy, rightBound, window.innerHeight);
      } else {
        cardLayout = { detached: true, x: r.left + dx, y: r.top + dy, width: r.width, height: r.height };
      }
      positionCard();
      positionToasts();
    };
    const end = (next) => {
      if (next && next.pointerId !== undefined && next.pointerId !== event.pointerId) return;
      card._pmEndGesture = null;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      window.removeEventListener("blur", end);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      card.removeEventListener("lostpointercapture", end);
      try { card.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      card.classList.remove("pm-card-moving", "pm-card-resizing");
      // A press on the grip that did not move is a click: open the controls.
      if (!moved && kind === "resize" && next?.type === "pointerup") toggleLayout();
      if (moved) {
        const box = card.getBoundingClientRect();
        cardLayout = { detached: true, x: box.left, y: box.top, width: box.width, height: box.height };
        saveCardLayout();
        placePill();
      }
    };
    const onVisibilityChange = () => { if (document.hidden) end(); };
    card._pmEndGesture = end;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
    window.addEventListener("blur", end);
    document.addEventListener("visibilitychange", onVisibilityChange);
    card.addEventListener("lostpointercapture", end);
  };
  head.addEventListener("pointerdown", e => begin(e, "move"));
  grip.addEventListener("pointerdown", e => begin(e, "resize"));
}

function clampCardResize(rect, dx, dy, rightBound, viewportHeight) {
  return {
    detached: true,
    x: rect.left,
    y: rect.top,
    width: Math.max(1, Math.min(Math.max(260, rect.width + dx), rightBound - rect.left)),
    height: Math.max(1, Math.min(Math.max(180, rect.height + dy), viewportHeight - 12 - rect.top)),
  };
}

function clampCardLayout(layout, viewportWidth, viewportHeight, boundary) {
  const margin = Math.min(12, viewportWidth / 4, viewportHeight / 4);
  const right = Math.max(margin + 1, Math.min(viewportWidth - margin, boundary));
  const availableWidth = Math.max(1, right - margin);
  const availableHeight = Math.max(1, viewportHeight - 2 * margin);
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const width = Math.min(availableWidth, Math.max(260, finite(layout.width, 520)));
  const height = Math.min(availableHeight, Math.max(180, finite(layout.height, 260)));
  return {
    width, height,
    x: Math.max(margin, Math.min(finite(layout.x, margin), right - width)),
    y: Math.max(margin, Math.min(finite(layout.y, margin), viewportHeight - margin - height)),
  };
}

/**
 * Hang the card off the pill.
 *
 * The pill is the fixed point the user learns, so the card opens from it: same
 * side, same edge, above it when the pill sits low (the default) and below it
 * when the pill has been dragged up high. The composer is still respected —
 * where the two overlap horizontally the card stops short of the composer's
 * top, because a rewrite has to be judged against the text it belongs to and
 * cannot be judged while covering it.
 */
const CARD_MAX_SHARE = 0.45;   // of the window's height, for a card on the chat box

/**
 * Name the Original toggle for the layout. Side by side (a card dragged out
 * wide) both texts are on screen, so it picks which one Replace uses; in the
 * sheet it switches which one is shown. It is an icon, so the name is its
 * label and its tooltip.
 */
function labelCardToggle(card, wide) {
  const toggle = card.querySelector("#pm-card-toggle");
  if (!toggle) return;
  const label = `${wide ? "Use" : "Show"} ${cardShowingOriginal ? "the rewrite" : cardSubject ? "the saved prompt" : "your original"}`;
  if (toggle.getAttribute("aria-label") === label) return;
  toggle.setAttribute("aria-label", label);
  toggle.dataset.pmTip = label;
}

function positionCard() {
  const card = document.getElementById("pm-card");
  const pill = document.getElementById("pm-trigger");
  if (!card || !pill) return;

  const composer = findComposer();
  const gap = 8;
  const margin = 12;
  const pillBox = pill.getBoundingClientRect();

  // The library no longer takes a column of the page: it is a sheet on the
  // pill that sits above the card while open and goes away on the next click
  // elsewhere, so the card keeps the whole width.
  const rightBound = window.innerWidth - margin;

  // Once the user moves or resizes the card, their layout wins. Keep every
  // edge reachable after a window resize or after the library panel opens.
  if (cardLayout?.detached) {
    const { width, height, x: left, y: top } = clampCardLayout(cardLayout, window.innerWidth, window.innerHeight, rightBound);
    card.classList.add("pm-card-free");
    const wide = width >= 900 && cardState === "ready";
    card.classList.toggle("pm-card-wide", wide);
    labelCardToggle(card, wide);
    card.classList.remove("pm-card-below");
    card.dataset.anchor = "free";
    card.style.width = width + "px";
    card.style.height = height + "px";
    card.style.left = left + "px";
    card.style.top = top + "px";
    markScrollable(card.querySelector(".pm-card-text"));
    return;
  }

  card.classList.remove("pm-card-free");
  card.classList.remove("pm-card-wide");
  labelCardToggle(card, false);
  card.style.height = "";

  // A sheet on the composer: as wide as the box (capped), right-aligned to
  // it, so it reads as a suggestion growing out of the box it will land in.
  // The first cut hung the card off the pill and then pushed it up to clear
  // the composer, which left it 450px from the pill and aligned to nothing.
  // With no composer on the page it hangs off the pill instead.
  // The chat box as drawn, not the editable inside it: hosts pad the text
  // within a rounded frame, and a card fitted to the editable sat 9px down
  // over that frame and short of its edges.
  const box = composer ? composerFrame(composer) : null;
  const onComposer = Boolean(box) && box.width >= 240 && box.top > margin + 120;
  let width, left;
  if (onComposer) {
    width = Math.min(600, Math.max(280, Math.min(box.width, rightBound - 2 * margin)));
    // Aligned to the composer's edge on the pill's side, so the two share an
    // edge whichever way the pill is docked.
    left = pillDock === "left" ? box.left : box.right - width;
  } else {
    width = Math.min(520, Math.max(300, rightBound - 2 * margin));
    left = pillDock === "left" ? pillBox.left : pillBox.right - width;
  }
  width = Math.min(width, Math.max(1, rightBound - margin));
  left = Math.max(margin, Math.min(left, rightBound - width));

  card.style.width = width + "px";
  card.style.left = left + "px";

  // Everything that is not the scrolling rewrite: head, chip, footer.
  // Measured rather than assumed, because the head's height varies with its
  // text.
  const textEl = card.querySelector(".pm-card-text");
  // Not named `chrome`: this file reaches for the extension API global by that
  // name throughout, and shadowing it inside a function is a trap for the next
  // line added here.
  const frame = card.offsetHeight - (textEl ? textEl.clientHeight : 0);
  // max-height applies to the text's content box, and clientHeight above
  // counts its padding: without this the card came out that much taller than
  // the room it was fitted to, and on a short window ran into the chat box.
  const textCs = textEl && getComputedStyle(textEl);
  const textPad = textCs ? parseFloat(textCs.paddingTop) + parseFloat(textCs.paddingBottom) : 0;

  const overlapsComposer = Boolean(box) && left < box.right && left + width > box.left;

  // The pill yields to the card, never the other way round. The card is
  // transient and belongs to the composer — the rewrite has to be read next
  // to the box it is going into — while the pill's spot is a resting
  // preference. An earlier cut pushed the card up above a pill that had been
  // dragged high, which detached it from the composer and squeezed the text
  // to its minimum. placePill() reads this to know when to step aside.
  card.dataset.anchor = onComposer ? "composer" : "pill";

  // Above the composer when sitting on it; otherwise above the pill when the
  // pill is in the lower half of the window, below it when it has been
  // dragged up high.
  const useAbove = onComposer || pillBox.top + pillBox.height / 2 >= window.innerHeight / 2;

  let room, top;
  const MIN_TEXT = 88;
  // The whole card, frame included, takes at most this much of the window.
  // The text alone was capped at 40vh, and the frame around it (title, style
  // row, context used, the first-run tip, the foot) came on top: a long Deep
  // rewrite covered two thirds of the window and the conversation behind it.
  // The rewrite scrolls inside instead.
  const cap = Math.max(MIN_TEXT + frame + textPad, Math.round(window.innerHeight * CARD_MAX_SHARE));
  if (useAbove) {
    // The card's bottom edge: just above whatever it sits on, and never over
    // the composer.
    let floor = (onComposer ? box.top : pillBox.top) - gap;
    if (overlapsComposer && box.top - gap < floor) floor = box.top - gap;
    room = Math.min(floor - margin, cap);
    // Give the rewrite whatever is left over, rather than letting the card grow
    // past the space it has. Clamping the card's TOP against the viewport
    // instead would walk it down over the composer exactly when the head made
    // it taller. MIN_TEXT stops a short window collapsing the rewrite to a
    // sliver.
    card.style.setProperty("--pm-card-text-max", Math.max(MIN_TEXT, room - frame - textPad) + "px");
    top = Math.max(margin, floor - (card.offsetHeight || 160));
  } else {
    let ceiling = pillBox.bottom + gap;
    let floor = window.innerHeight - margin;
    if (overlapsComposer && box.top > ceiling) floor = box.top - gap;
    room = Math.min(floor - ceiling, cap);
    card.style.setProperty("--pm-card-text-max", Math.max(MIN_TEXT, room - frame - textPad) + "px");
    top = ceiling;
  }
  card.style.top = top + "px";
  card.classList.toggle("pm-card-below", !useAbove);

  // The height budget just changed, so whether anything is still below the fold
  // changed with it.
  markScrollable(textEl);
}

function openCard(innerHTML) {
  hideTip();   // the card is what the user is looking at now
  const card = getOrCreateCard();
  const focusedId = card.contains(document.activeElement) ? document.activeElement.id : null;
  card._pmEndGesture?.();
  // A card coming up means the user moved on from the library (⊕ with
  // prompts ticked, the shortcut, a draft reopened): the sheet would sit
  // over the card's top edge, so it goes.
  // That card is the one now, not the one the sheet folded away.
  if (!cardExpanded && panelOpen) { libFoldedCard = null; togglePanel(false); }
  card.innerHTML = innerHTML + `<div class="pm-card-strip" id="pm-card-strip"></div>` +
    `<button type="button" class="pm-card-resize" id="pm-card-resize" aria-label="Card size and position" aria-expanded="false" aria-controls="pm-card-layout" title="Drag to resize, or click to move and size with buttons"></button>`;
  cardExpanded = true;
  card.classList.toggle("pm-card-tucked", cardTucked);
  renderStrip();
  positionRail();   // the card takes the chat box's top edge; the rail steps aside
  setupCardInteractions(card);
  if (focusedId) card.querySelector(`[id="${focusedId}"]`)?.focus({ preventScroll: true });
  positionCard();
  requestAnimationFrame(() => card.classList.add("pm-card-visible"));

  if (!cardReposition) {
    cardReposition = () => positionCard();
    window.addEventListener("resize", cardReposition, true);
    window.addEventListener("scroll", cardReposition, true);
  }
  return card;
}

/** Take the card off screen. The draft stays, in the pill. */
function hideCard() {
  const card = document.getElementById("pm-card");
  if (card) {
    // Minimize toward the pill rather than blink out: the pill is where the
    // draft went, and the motion says so. The id is dropped at once so a
    // re-open during the 160ms builds a fresh card instead of reviving this one.
    card._pmEndGesture?.();
    if (card.contains(document.activeElement)) document.getElementById("pm-trigger")?.focus({ preventScroll: true });
    card.id = "";
    // Its controls' ids go too. A card opened during the fade wires its
    // buttons by id, and getElementById returns the first match in the page:
    // the leaving card's. Its Replace then had no listener and did nothing.
    card.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    card._pmResize?.disconnect();
    const pill = document.getElementById("pm-trigger");
    const up = pill && pill.getBoundingClientRect().top < card.getBoundingClientRect().top;
    card.classList.remove("pm-card-visible");
    card.classList.add("pm-card-leaving", up ? "pm-card-leaving-up" : "pm-card-leaving-down");
    setTimeout(() => card.remove(), 180);
  }
  if (cardReposition) {
    window.removeEventListener("resize", cardReposition, true);
    window.removeEventListener("scroll", cardReposition, true);
    cardReposition = null;
  }
  cardExpanded = false;
  cardTucked = false;
  cardMinimized = true;
  // Folding the card leaves the pill as it was, so placement is not re-run on
  // its own; the rail has to be told the edge is free again.
  positionRail();
  draftStore.setExpanded(false);
  renderPill();
}

// ── Tucked: a strip on the chat box while the user reads the conversation ──
//
// The card sits on the chat box, which is also where the latest messages are.
// Scrolling the conversation or clicking in it means the user went back to
// the page: the card folds to a 40px strip that still says what the draft is
// and still carries its verb. A click on the strip, ⌘⇧P, the pill or the
// rewrite shortcut opens it again. Hover does not: the strip lies where the
// pointer passes on its way to the chat box.

/** What counts as "the page" and not the extension's own surfaces. */
const PM_SURFACES = "#pm-card, #pm-trigger, #pm-library, #pm-library-btn, #pm-help-btn, #pm-peek, #pm-save, #pm-keys, #pm-caret, #pm-rail, " +
  "#pm-tip, #pm-toast-stack, .pm-modal-overlay, #pm-voice";

function renderStrip() {
  const strip = document.getElementById("pm-card-strip");
  if (!strip) return;
  if (!cardTucked) { strip.innerHTML = ""; return; }
  let label, gist, verb = "";
  if (cardState === "streaming") {
    label = "Rewriting\u2026";
    // The newest words, so the line's end is the live edge.
    const t = norm(pillStreamingPreview);
    gist = t.length > 70 ? "…" + t.slice(-70) : t;
  } else if (cardState === "error") {
    label = "Rewrite failed";
    gist = cardError;
    verb = "Retry";
  } else {
    label = cardStale ? "Chat box changed" : cardSubject ? "Improved" : "Rewrite ready";
    gist = cardResult?.enhanced || "";
    verb = cardStale ? "Redo" : draftVerb();
  }
  strip.dataset.state = cardState === "ready" && cardStale ? "stale" : cardState;
  strip.innerHTML =
    `<span class="pm-card-strip-dot" aria-hidden="true"></span>` +
    `<span class="pm-card-strip-label">${escHtml(label)}</span>` +
    `<span class="pm-card-strip-gist">${escHtml(norm(gist))}</span>` +
    (verb ? `<button type="button" class="pm-card-strip-verb" data-act="verb">${verb}</button>` : "") +
    `<button type="button" class="pm-card-strip-open" data-act="open" aria-label="Show the whole rewrite" data-pm-tip="Show the whole rewrite" data-pm-key="${MOD_SHIFT}P">` +
    `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5 6 4.5l3 3"/></svg></button>`;
  if (!strip._pmWired) {
    strip._pmWired = true;
    strip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target.closest("[data-act='verb']")) { pillVerb(); return; }
      untuckCard();
    });
  }
}

function setCardTucked(tucked) {
  const card = document.getElementById("pm-card");
  if (!card || !cardExpanded || cardTucked === tucked) return;
  // Focus inside a card that is about to fold would be left on a hidden
  // button; the strip's open button is where it can go on.
  const hadFocus = card.contains(document.activeElement);
  cardTucked = tucked;
  card.classList.toggle("pm-card-tucked", tucked);
  renderStrip();
  if (hadFocus) {
    const next = tucked ? card.querySelector(".pm-card-strip-open") : card.querySelector("#pm-card-min");
    next?.focus({ preventScroll: true });
  }
  positionCard();
  placePill();
}

function tuckCard() {
  if (cardLayout?.detached) return;   // placed there on purpose: it stays as placed
  setCardTucked(true);
}

function untuckCard() {
  setCardTucked(false);
}

/** A wheel turn or a press on the page, outside the extension: fold the card. */
function tuckOnPageGesture(e) {
  if (!cardExpanded || cardTucked) return;
  if (e.target.closest?.(PM_SURFACES)) return;
  if (document.getElementById("pm-card")?._pmEndGesture) return;   // mid drag or resize
  tuckCard();
}

/** Show the card again for a draft the pill is holding. */
function expandCard() {
  cardMinimized = false;
  cardTucked = false;
  draftStore.setExpanded(true);
  if (cardState === "ready" && cardResult) showDiffModal(cardResult);
  else if (cardState === "error") failStreamingModal(cardError);
  else if (cardState === "streaming") showStreamingCardAgain();
}

function toggleCard() {
  // The pill is the card's handle: a tucked card opens again, an open one folds.
  if (cardExpanded && cardTucked) untuckCard();
  else if (cardExpanded) hideCard();
  else expandCard();
}

/** Discard the draft entirely: card, pill and storage. */
function closeCard() {
  if (cardState === "streaming" && cancelActiveStream) cancelActiveStream();
  cancelActiveStream = null;
  hideCard();
  cardState = "idle";
  cardResult = null;
  cardShowingOriginal = false;
  cardBasedOn = "";
  cardHasBaseline = false;
  cardStale = false;
  cardError = "";
  cardMinimized = false;
  pillStreamingPreview = "";
  cardVersions = [];
  cardVersionIndex = 0;
  cardRerunFrom = null;
  cardStreamingStyle = "";
  cardUsedOpen = false;
  cardSubject = null;
  draftStore.clear();
  renderPill();
}

/**
 * The card's actions, in one dock: a tray sized to what it holds, at the
 * card's bottom left. On a wide card a row spread edge to edge left Replace
 * on one side and the icons 600px away on the other; a tray reads as one
 * control at any width. CARD_SEP divides the kinds of action in it.
 */
function cardFoot(parts) {
  return `<div class="pm-card-foot"><div class="pm-card-dock" role="toolbar" aria-label="Rewrite actions">${parts.filter(Boolean).join("")}</div></div>`;
}
const CARD_SEP = `<span class="pm-card-sep" aria-hidden="true"></span>`;


/**
 * The card's title bar: what this card is, and the one window control it has.
 *
 * Minimize, not close. The draft is never lost from here — it folds down into
 * the pill and comes back with a click (or ⌘⇧P). Discard is a footer action,
 * deliberately further from the corner the hand goes to when it wants a
 * window out of the way. The bar also carries the stale and error notices, so
 * the card has the same anatomy in every state: head, text, foot. `extra`
 * goes between the name and the controls: the version stepper, when there is
 * more than one version to step through.
 */
function cardHead(title, kind = "", extra = "") {
  return `<div class="pm-card-head${kind ? " pm-card-head-" + kind : ""}" title="Drag to move">` +
    `<span class="pm-card-head-dot" aria-hidden="true"></span>` +
    `<span class="pm-card-title">${title}</span>` + extra +
    `<button class="pm-card-reset" type="button" id="pm-card-reset" title="Return beside the prompt" aria-label="Return card beside the prompt">↙</button>` +
    `<button class="pm-card-min" type="button" id="pm-card-min" data-pm-tip="Minimize to the pill" data-pm-key="Esc" aria-label="Minimize to the pill">${CARD_MIN_SVG}</button>` +
  `</div>`;
}

// ── Entry point 1: the flow is starting ──
function showStreamingDiffModal(originalText, style = currentMode) {
  cardStreamingStyle = style;
  cardOriginal = originalText;
  cardBasedOn = norm(originalText);
  cardHasBaseline = true;
  cardStale = false;
  cardState = "streaming";
  cardShowingOriginal = false;
  cardMinimized = false;
  cardTucked = false;
  pillStreamingPreview = "";
  showStreamingCardAgain();
  renderPill();
}

/** The streaming card's markup, also used to re-open it from the pill. */
function showStreamingCardAgain() {
  const what = cardSubject ? `Improving \u201c${escHtml(clipText(cardSubject.title, 32))}\u201d` : "Rewriting";
  openCard(
    cardHead(`${what}${STYLE_NAMES[cardStreamingStyle] ? " \u00b7 " + STYLE_NAMES[cardStreamingStyle] : ""}\u2026`, "live") +
    `<div class="pm-card-text" id="pm-stream-target"><span class="pm-card-cursor"></span></div>` +
    cardFoot([
      `<button class="pm-card-act pm-card-btn" id="pm-card-cancel" data-pm-tip="Stop this rewrite" data-pm-key="Esc">Cancel</button>`,
      `<span class="pm-card-spacer"></span>`,
      `<span class="pm-card-meta">the pill keeps it if you minimize</span>`,
    ])
  );
  if (pillStreamingPreview) updateStreamingText(pillStreamingPreview);
  document.getElementById("pm-card-cancel")?.addEventListener("click", cancelStreaming);
  document.getElementById("pm-card-min")?.addEventListener("click", hideCard);
}

// ── Entry point 2: tokens arriving ──
function updateStreamingText(text) {
  pillStreamingPreview = text;
  renderPill();
  if (cardTucked) renderStrip();
  const target = document.getElementById("pm-stream-target");
  if (!target) return;
  target.innerHTML = escHtml(text) + '<span class="pm-card-cursor"></span>';
  positionCard();
}

// ── Entry point 3: finished ──
function finalizeStreamingModal(result) {
  // Cancelled — or replaced by something else — while the tokens were still
  // arriving. The result is dropped; it is no longer the draft.
  if (cardState !== "streaming") return;
  statsBump("rewrites");
  tipDone("meet");
  if (cardRerunFrom) {
    cardVersions = [...cardRerunFrom.versions, result];
    cardRerunFrom = null;
  }
  showDiffModal(result);
}

/**
 * Stop the rewrite in flight. A first rewrite has nothing to fall back to, so
 * the draft goes; a style rerun goes back to the version it started from.
 */
function cancelStreaming() {
  if (cardState !== "streaming" || !cardRerunFrom) { closeCard(); return; }
  if (cancelActiveStream) cancelActiveStream();
  cancelActiveStream = null;
  restoreFromRerun();
}

/** Put the draft back exactly as it was before a style rerun started. */
function restoreFromRerun() {
  const from = cardRerunFrom;
  cardRerunFrom = null;
  cardVersions = from.versions;
  cardVersionIndex = from.index;
  cardState = "ready";
  pillStreamingPreview = "";
  showDiffModal(cardVersions[cardVersionIndex]);
}

// ── Entry point 4: failed ──
function failStreamingModal(message) {
  // Only a stream in flight (or a re-opened error) can become an error card;
  // a cancelled stream's late failure is nobody's business.
  if (cardState !== "streaming" && cardState !== "error") return;
  if (cardState === "streaming" && cardRerunFrom) {
    // The error card's "try again" and "dismiss" both discard the draft. For
    // a rerun that would throw away the version the user was happy enough
    // with to ask for a variation of, so it comes back instead.
    const style = STYLE_NAMES[cardStreamingStyle] || "new";
    restoreFromRerun();
    showToast(`Couldn\u2019t make the ${style} version: ${message}`, "error");
    return;
  }
  cardState = "error";
  cardError = message;
  renderPill();
  if (cardMinimized) return;
  openCard(
    cardHead("Couldn\u2019t rewrite", "error") +
    `<div class="pm-card-text pm-card-error">${escHtml(message)}<span class="pm-card-error-note">Your text in the chat box is untouched.</span></div>` +
    cardFoot([
      `<button class="pm-card-act pm-card-btn pm-card-primary" id="pm-card-retry">Try again</button>`,
      `<button class="pm-card-act pm-card-btn" id="pm-card-dismiss" data-pm-tip="Dismiss" data-pm-key="Esc">Dismiss</button>`,
    ])
  );
  document.getElementById("pm-card-retry")?.addEventListener("click", () => { closeCard(); handleEnhance(); });
  document.getElementById("pm-card-dismiss")?.addEventListener("click", closeCard);
  document.getElementById("pm-card-min")?.addEventListener("click", hideCard);
}

/** The finished state. Named showDiffModal because several other flows
 *  (voice, re-enhance, feedback) already call it. */
function showDiffModal(result) {
  // A new draft from another entry point (voice, history) always shows
  // itself. The streaming flow finishing is the SAME draft the user already
  // minimized, and the \ toggle or a staleness flip re-renders the same
  // result — all of those respect the minimize.
  if (result !== cardResult && cardState !== "streaming") cardMinimized = false;
  // A result that is not one of this draft's versions is a new draft.
  if (!cardVersions.includes(result)) cardVersions = [result];
  cardVersionIndex = cardVersions.indexOf(result);
  cardResult = result;
  cardState = "ready";
  lastEnhanceResult = result;

  // Entry points other than the streaming flow (voice, history) never set this.
  if (!cardHasBaseline) {
    cardBasedOn = norm(result.original || cardOriginal || "");
    cardHasBaseline = true;
  }

  // Recomputed on every render, so a rewrite that was in flight while the user
  // edited arrives stale rather than appearing fresh and wrong.
  cardStale = isStaleAgainstComposer();

  // Written through so the draft outlives this page. Cheap, and idempotent.
  draftStore.save({
    result,
    versions: cardVersions,
    index: cardVersionIndex,
    basedOn: cardBasedOn,
    createdAt: result.createdAt || Date.now(),
    source: window.location.hostname,
    expanded: !cardMinimized,
    subject: cardSubject,
  });
  if (!result.createdAt) result.createdAt = Date.now();

  // Minimized: the pill carries the state (green, Insert) and the card stays
  // folded until asked for. Popping open over whatever the user moved on to
  // is exactly what minimizing was meant to stop.
  if (cardMinimized) { renderPill(); return; }

  const original = escHtml(result.original || cardOriginal);
  const enhanced = escHtml(result.enhanced);
  const body = `<div class="pm-card-comparison">` +
    `<div class="pm-card-reading"><div class="pm-card-pane-label">Selected: ${cardShowingOriginal ? "Original" : "Rewrite"}</div>` +
    `<div class="pm-card-text${cardShowingOriginal ? " pm-card-original" : ""}">${cardShowingOriginal ? original : enhanced}</div></div>` +
    `<div class="pm-card-reference"><div class="pm-card-pane-label">${cardShowingOriginal ? "Rewrite" : cardSubject ? "Saved prompt" : "Original"}</div>` +
    `<div class="pm-card-reference-text">${cardShowingOriginal ? enhanced : original}</div></div></div>`;

  // Named rather than merely dimmed. "Why is this greyed out" is a worse
  // question to leave a user holding than one line of explanation.
  //
  // The wording follows the toggle. Under \, the body IS the earlier text, so
  // calling it "a rewrite for the earlier text" would be pointing at the wrong
  // thing — the user would look for a staleness that is not on screen.
  // Which saved prompts shaped this rewrite: named in a chip in the title
  // bar, and listed under the text when the chip is opened, each with a way to
  // drop an auto-matched one and rewrite again without it. Only shown when a
  // saved prompt actually took part.
  const used = cardUsedParts(result);
  const head = cardStale
    ? cardHead(cardShowingOriginal
        ? "Prompt changed \u2014 this is the text the rewrite was built from"
        : "Prompt changed \u2014 this rewrite is for the earlier text", "stale")
    : cardHead(cardShowingOriginal
        ? (cardSubject ? "Saved prompt, as it is" : "Original")
        : `${cardSubject ? `Improved \u201c${escHtml(clipText(cardSubject.title, 32))}\u201d` : "Rewrite"}${STYLE_NAMES[result.mode] ? " \u00b7 " + STYLE_NAMES[result.mode] : ""}`,
      "", used.chip + cardVersionsHtml());


  // Only when it matters: how long the rewrite took was a number nobody acted on.
  const truncatedNote = result.truncated
    ? `<span class="pm-card-meta" style="color:var(--pm-danger);margin-right:6px">cut short</span>`
    : "";

  // Buttons, not a legend of keys. The foot once read "Replace draft · esc
  // minimize · Show original · ⌘S save · discard · 1.05s": a keycap on every
  // action, and the one thing most people came to do drawn as coloured text.
  //
  // Then it was a band of its own under a row of style buttons, and the card
  // read as boxes stacked under the text. Now there is one row: Replace, the
  // other styles beside it, and at the far end three quiet icons, Original,
  // Save and Discard, whose names and keys show where the pointer rests.
  // Discard stays last, furthest from Replace.
  //
  // Stale, Redo takes accept's place: using a rewrite of text the user has
  // since changed is the one thing the card must not offer first.
  const acceptLabel = cardSubject
    ? (cardShowingOriginal ? "Keep it as it is" : "Update saved prompt")
    : cardShowingOriginal ? "Use original" : norm(getCurrentInputText()) ? "Replace draft" : "Insert";
  const lead = cardStale
    ? `<button class="pm-card-act pm-card-btn pm-card-primary pm-card-redo" id="pm-card-redo" data-pm-tip="Rewrite what is in the chat box now" data-pm-key="${CMD_ENTER}">Redo</button>`
    : `<button class="pm-card-act pm-card-btn pm-card-primary" id="pm-card-accept">${acceptLabel}</button>`;

  const saved = Boolean(cardSavedId(result));
  const saveTip = saved ? "Saved \u00b7 show it in your library" : cardSubject ? "Save as a new prompt" : "Save to your library";
  // Use it │ change it │ keep or drop it. The middle group is absent on a
  // stale draft and on the original, and its divider goes with it.
  const styles = cardStyleButtons(result);
  const actions = [
    lead,
    styles && CARD_SEP + styles,
    CARD_SEP,
    `<span class="pm-card-tools">${truncatedNote}` +
      `<button class="pm-card-act pm-card-icon" id="pm-card-toggle" aria-pressed="${cardShowingOriginal}">${CARD_COMPARE_SVG}</button>` +
      `<button class="pm-card-act pm-card-icon${saved ? " pm-card-saved" : ""}" id="pm-card-save" aria-pressed="${saved}" aria-label="${saveTip}" data-pm-tip="${saveTip}"${saved ? "" : ` data-pm-key="${CMD_KEY}S"`}>${BOOKMARK_SVG}</button>` +
      `<button class="pm-card-act pm-card-icon pm-card-discard" id="pm-card-discard" aria-label="Discard this rewrite" data-pm-tip="Discard this rewrite">${CARD_DISCARD_SVG}</button>` +
    `</span>`,
  ];

  // Where the user had scrolled to in the rewrite. A staleness flip rebuilds
  // the card, which threw the reading position away: you scroll down, edit
  // your prompt *because* of what you just read, and the card snaps back to
  // the top. Restored only when it is genuinely the same text — toggling to
  // the original, or a new result, should start from the beginning.
  const prevTextEl = document.querySelector("#pm-card .pm-card-text");
  const prevScroll = prevTextEl ? prevTextEl.scrollTop : 0;
  const prevContent = prevTextEl ? prevTextEl.textContent : null;

  // The bar goes above the body: it qualifies the whole card, and a status
  // printed underneath the thing it qualifies is read too late to help.
  const card = openCard(head + body + used.list + cardTipHtml() + cardRateHtml(result) + cardFoot(actions));
  card.classList.toggle("pm-card-stale", cardStale);

  const textEl = card.querySelector(".pm-card-text");
  if (textEl && prevScroll && textEl.textContent === prevContent) {
    textEl.scrollTop = prevScroll;
  }
  watchScrollable(textEl);
  markScrollable(textEl);

  document.getElementById("pm-card-accept")?.addEventListener("click", acceptCard);
  document.getElementById("pm-card-min")?.addEventListener("click", hideCard);
  document.getElementById("pm-card-discard")?.addEventListener("click", closeCard);
  document.getElementById("pm-card-redo")?.addEventListener("click", redoCard);
  document.getElementById("pm-card-toggle")?.addEventListener("click", () => {
    cardShowingOriginal = !cardShowingOriginal;
    showDiffModal(cardResult);
  });
  document.getElementById("pm-card-save")?.addEventListener("click", saveCard);
  card.querySelectorAll("[data-pm-style]").forEach((b) =>
    b.addEventListener("click", () => rerunInStyle(b.dataset.pmStyle)));
  card.querySelectorAll("#pm-card-rate [data-rate]").forEach((b) =>
    b.addEventListener("click", () => rateCard(b.dataset.rate)));
  document.getElementById("pm-card-ver-prev")?.addEventListener("click", () => stepVersion(-1));
  document.getElementById("pm-card-ver-next")?.addEventListener("click", () => stepVersion(1));
  document.getElementById("pm-card-used-toggle")?.addEventListener("click", (e) => {
    cardUsedOpen = !cardUsedOpen;
    e.currentTarget.setAttribute("aria-expanded", String(cardUsedOpen));
    const list = document.getElementById("pm-card-used-list");
    if (list) list.hidden = !cardUsedOpen;
    positionCard();
  });
  card.querySelectorAll("[data-pm-drop]").forEach((b) =>
    b.addEventListener("click", () => rerunWithout(b.dataset.pmDrop, b.dataset.pmTitle || "")));
  renderPill();
}

/**
 * The saved prompts that shaped a rewrite: the ones the user attached, and
 * the ones the server matched on its own. A matched one can be dropped, which
 * rewrites the same text again without it (a new version; the old one stays).
 *
 * Two parts. `chip` goes in the title bar: the first name and how many more,
 * with all of them in its tooltip. `list` goes under the text, folded until the
 * chip is pressed. It was a line between the text and the actions, where it
 * sat on the text's fade and crowded the buttons. Neither is shown on the
 * original, or on a stale draft, whose title bar has a notice to give.
 */
function cardUsedParts(result) {
  const none = { chip: "", list: "" };
  if (cardShowingOriginal || cardStale) return none;
  const d = result.context_details || {};
  const items = [
    ...(d.selected_prompts || []).map((p) => ({ ...p, kind: "attached" })),
    ...(d.auto_matched_prompts || []).map((p) => ({ ...p, kind: "matched" })),
  ];
  const left = result.excluded || [];
  if (!items.length && !left.length) {
    // A server that sends counts only.
    const n = (result.context_used?.auto_matched || 0) + (result.context_used?.selected || 0);
    return n ? { chip: `<span class="pm-card-ctx" title="Saved prompts this rewrite drew on"><span class="pm-card-used-arrow" aria-hidden="true">\u21B3</span>${n} used</span>`, list: "" } : none;
  }
  const flat = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + "\u2026" : t);
  const name = (p) => flat(p.title) || clip(flat(p.content), 40) || "Saved prompt";
  const summary = items.length
    ? escHtml(clip(name(items[0]), 24)) + (items.length > 1 ? ` +${items.length - 1}` : "")
    : "None used";
  const all = items.length ? "Context: " + items.map((p) => escHtml(clip(name(p), 60))).join(", ") : "No saved prompts used as context";
  const rows = items.map((p) => {
    // Said the way a person would: "close match" and "loose match" named the
    // matcher's score, and testers did not know what to make of it.
    const why = p.kind === "attached" ? "you added it" : "picked for you";
    const preview = p.title && p.content ? " \u00b7 " + escHtml(clip(flat(p.content), 80)) : "";
    const drop = p.kind === "matched" && p.id && !cardStale
      ? `<button type="button" class="pm-card-used-drop" data-pm-drop="${escHtml(p.id)}" data-pm-title="${escHtml(name(p))}" ` +
        `title="Rewrite again without this saved prompt">Don\u2019t use</button>`
      : "";
    return `<li class="pm-card-used-item pm-card-used-${p.kind}">` +
      `<span class="pm-card-used-icon" aria-hidden="true">${p.kind === "attached" ? LIB_ICON.clip : CARD_SPARK_SVG}</span>` +
      `<span class="pm-card-used-text"><span class="pm-card-used-name">${escHtml(clip(name(p), 60))}</span>` +
      `<span class="pm-card-used-why">${why}${preview}</span></span>${drop}</li>`;
  }).join("");
  const leftOut = left.length
    ? `<li class="pm-card-used-left">Left out: ${left.map((x) => escHtml(clip(flat(x.title) || "a saved prompt", 40))).join(", ")}</li>`
    : "";
  return {
    chip: `<button type="button" class="pm-card-ctx pm-card-used-toggle" id="pm-card-used-toggle" aria-expanded="${cardUsedOpen}" ` +
      `aria-controls="pm-card-used-list" title="${all}" aria-label="${all}"><span class="pm-card-used-arrow" aria-hidden="true">\u21B3</span>` +
      `<span class="pm-card-ctx-name">${summary}</span><span class="pm-card-used-caret" aria-hidden="true">\u25BE</span></button>`,
    list: `<ul class="pm-card-used-list" id="pm-card-used-list" aria-label="Context for this rewrite"${cardUsedOpen ? "" : " hidden"}>` +
      `<li class="pm-card-used-head">Context for this rewrite</li>${rows}${leftOut}</ul>`,
  };
}

/**
 * The other two styles, as buttons in the card's one row of actions. (The
 * versions already made are stepped through in the title bar.)
 *
 * They had a row of their own between the text and the foot, which made the
 * card three bands of controls under the text. Beside Replace they read as
 * what they are: other things to do with this rewrite.
 *
 * Hidden while the original is showing (there is no rewrite to vary) and while
 * the draft is stale (Redo is the only honest action then). A style already
 * made is shown rather than re-requested: switching back to it is free, and
 * spending one of fifteen daily rewrites on text you have already seen is the
 * thing these buttons must never do.
 */
function cardStyleButtons(result) {
  if (cardShowingOriginal || cardStale) return "";
  const on = STYLES.includes(result.mode) ? result.mode : currentMode;
  const left = result.direct ? Infinity : usageData.limit - usageData.count;
  const cost = result.direct ? "Makes one more call with your own key." : "Uses one of today\u2019s rewrites.";
  const styles = STYLES.filter((s) => s !== on).map((s) => {
    const made = cardVersions.some((v) => v.mode === s);
    const spent = !made && left <= 0;
    const note = !made && left > 0 && left <= 3 ? ` \u00b7 ${left} left` : "";
    const title = made
      ? `Show the ${STYLE_NAMES[s]} version you already made`
      : spent
        ? "No rewrites left today"
        : `Rewrite your original again in the ${STYLE_NAMES[s]} style: ${STYLE_HINTS[s]}. ${cost}`;
    return `<button type="button" class="pm-card-style${made ? " pm-card-style-made" : ""}" id="pm-card-style-${s}" data-pm-style="${s}"` +
      `${spent ? ' aria-disabled="true"' : ""} title="${escHtml(title)}">${CARD_SPARK_SVG}${STYLE_VERBS[on][s]}${note}</button>`;
  }).join("");
  return `<span class="pm-card-styles" role="group" aria-label="Other styles">${styles}</span>`;
}

/**
 * The way back through the versions already made, for the title bar: it says
 * which rewrite the card is showing, so it sits beside the card's name.
 * Hidden on the original, and on a stale draft, whose bar has a notice to give.
 */
function cardVersionsHtml() {
  const n = cardVersions.length;
  if (n < 2 || cardShowingOriginal || cardStale) return "";
  return `<span class="pm-card-versions" role="group" aria-label="Versions">` +
    `<button type="button" class="pm-card-ver" id="pm-card-ver-prev" aria-label="Previous version" title="Previous version ([)"${cardVersionIndex === 0 ? " disabled" : ""}>\u2039</button>` +
    `<span aria-live="polite">${cardVersionIndex + 1} of ${n}</span>` +
    `<button type="button" class="pm-card-ver" id="pm-card-ver-next" aria-label="Next version" title="Next version (])"${cardVersionIndex === n - 1 ? " disabled" : ""}>\u203a</button>` +
    `</span>`;
}

/** Show another version of this draft. Free: nothing is requested. */
function stepVersion(delta) {
  const i = cardVersionIndex + delta;
  if (cardState !== "ready" || i < 0 || i >= cardVersions.length) return;
  cardShowingOriginal = false;
  showDiffModal(cardVersions[i]);
}

/**
 * Rewrite the same original again in another style, keeping the versions
 * already made. The default ⊕ runs is not changed by this.
 */
async function rerunInStyle(style) {
  if (cardState !== "ready" || !cardResult || cardStale || !STYLES.includes(style)) return;
  const made = cardVersions.findIndex((v) => v.mode === style);
  if (made !== -1) { stepVersion(made - cardVersionIndex); return; }
  // A saved prompt the user dropped stays dropped in the other styles.
  await rerunDraft(style, cardResult.excluded || []);
}

/** Rewrite the same text again, in the same style, without one saved prompt. */
async function rerunWithout(id, title) {
  if (cardState !== "ready" || !cardResult || cardStale || cardResult.direct || !id) return;
  const excluded = [...(cardResult.excluded || []).filter((x) => x.id !== id), { id, title }];
  await rerunDraft(STYLES.includes(cardResult.mode) ? cardResult.mode : currentMode, excluded);
}

/** A new version of this draft; the versions already made are kept. */
async function rerunDraft(style, excluded = []) {
  tipDone("card");   // they found the style buttons
  if (enhanceInFlight) {
    showToast("Already enhancing \u2014 hang on a moment.", "info");
    return;
  }
  if (!cardResult.direct && usageData.limit - usageData.count <= 0) {
    showToast("No rewrites left today.", "error");
    return;
  }
  const original = cardVersions[0]?.original || cardResult.original || cardOriginal;
  if (!original) return;
  const route = await resolveEnhanceRoute();
  // The user may have inserted, discarded or edited while the worker answered.
  if (!route || cardState !== "ready" || isStaleAgainstComposer()) return;

  cardRerunFrom = { versions: cardVersions.slice(), index: cardVersionIndex };
  // Staleness is judged against what the draft was built from, which is not
  // always the text being rewritten: a voice draft's baseline is the chat box
  // as it was when recording started, and its original is the transcript.
  // showStreamingDiffModal() rebases on the text it is given, so the rerun
  // puts the draft's own baseline back. Without this, a voice draft taken over
  // a half-written message turned stale the moment a style was tried.
  const basedOn = cardBasedOn;
  enhanceInFlight = true;
  showStreamingDiffModal(original, style);
  cardBasedOn = basedOn;
  try {
    if (route.route === "direct") await runDirectEnhance(original, route, style);
    else await runBackendEnhance(original, {
      excludedIds: [...excluded.map((x) => x.id), ...(cardSubject ? [cardSubject.id] : [])],
      excluded,
    }, style);
  } catch (err) {
    console.error("Prompt Memory: rerun failed", err);
    failStreamingModal(err?.message || "Enhancement failed. Please try again.");
  } finally {
    enhanceInFlight = false;
  }
}

/**
 * Re-run against what is in the composer now.
 *
 * Deliberately manual. Re-running automatically as the user types would spend a
 * real model call per keystroke against a ration of fifteen a day, and would
 * always be a second or two behind — replacing itself with rewrites of
 * half-finished sentences.
 */
function redoCard() {
  closeCard();
  handleEnhance();
}

/**
 * Recompute staleness against the live composer.
 *
 * Only re-renders on a transition, so typing does not rebuild the card on every
 * keystroke.
 */
function refreshCardStaleness() {
  if (cardState !== "ready" || !cardResult) return;
  const stale = isStaleAgainstComposer();
  // The pill's Insert/Apply wording tracks whether the box is empty, which
  // can change without the stale flag changing. renderPill() is a no-op
  // unless something it shows actually differs.
  renderPill();
  if (stale === cardStale) return;
  cardStale = stale;
  if (cardExpanded) showDiffModal(cardResult);
  else renderPill();
}

// The whole mechanism. Listening for edits anywhere is fine because
// refreshCardStaleness() is a no-op unless a finished rewrite is on screen.
document.addEventListener("input", refreshCardStaleness, true);

/** Write the rewrite into the composer. */
async function acceptCard() {
  if (cardState !== "ready" || !cardResult) return;
  if (cardSubject) { await acceptImprovement(); return; }
  if (cardStale || isStaleAgainstComposer()) {
    // The dangerous action. Accepting here would replace what the user just
    // typed with a rewrite of text that no longer exists — and it would report
    // success, correctly, because the write really did land. Their work is what
    // would be destroyed.
    showToast("The prompt changed — choose Redo before replacing it.", "error");
    return;
  }
  const applyingEnhanced = !cardShowingOriginal;
  const text = applyingEnhanced ? cardResult.enhanced : (cardResult.original || cardOriginal);
  const result = cardResult;
  // What Undo needs: the chat box exactly as it was, and the draft, so the
  // rewrite comes back on the card rather than being lost with the old text.
  const undo = {
    before: getCurrentInputText(),
    written: text,
    draft: { result, versions: cardVersions.slice(), basedOn: cardBasedOn, original: cardOriginal },
  };
  closeCard();

  // One event, one toast. The feedback toast carries the confirmation itself,
  // so applyOrFallback is told to stay quiet on success — but only when there
  // is actually something to rate. Without a log_id the rating cannot be sent
  // anywhere, and asking anyway spends the user's attention on nothing.
  // Rated on the card already: the pill confirms and does not ask again.
  const canRate = Boolean(result.log_id) && !cardRatings.has(result.log_id);
  const applied = await applyOrFallback(text, null);
  // The pill says "Inserted" and, when there is a log_id to rate against,
  // asks how it was — in the object the user was already looking at, rather
  // than a toast beside a pill that had just collapsed.
  if (applied) showApplied(canRate ? result : null, undo);
  if (applied) {
    tipDone("card");
    statsBump("inserts");
    maybeTipSave();
  }
  if (applied && applyingEnhanced && result.log_id) {
    await approveEnhancement(result.log_id);
  }
}

/**
 * Write an Improve draft back over the saved prompt it came from. The old
 * text is one Undo away, and the chat box is not touched.
 */
async function acceptImprovement() {
  const subject = cardSubject;
  const result = cardResult;
  if (cardShowingOriginal) {
    closeCard();
    showToast("Kept your saved prompt as it was.", "info");
    return;
  }
  const ok = await updateSavedPrompt(subject.id, { content: result.enhanced });
  if (!ok) {
    // The draft stays, so nothing is lost: the user can retry or save as new.
    showToast("Could not update the saved prompt. Try again, or save it as new.", "error");
    return;
  }
  closeCard();
  await fetchSavedPrompts();
  if (result.log_id) approveEnhancement(result.log_id);
  showToast(`Updated \u201c${clipText(subject.title, 40)}\u201d`, "success", {
    label: "Undo",
    run: async () => {
      const back = await updateSavedPrompt(subject.id, { content: subject.content });
      await fetchSavedPrompts();
      showToast(back ? "Restored the earlier version." : "Could not restore it.", back ? "info" : "error");
    },
  });
}

// Rewrites saved from the card whose save the library list has not caught up
// with yet: the text, and the saved prompt's id. The list is the truth once it
// arrives, so a prompt deleted from the library un-fills the bookmark.
const cardSavePending = new Map();
let cardSaving = false;

/** The saved prompt holding this rewrite's text, if there is one. */
function cardSavedId(result) {
  const text = norm(result?.enhanced);
  if (!text) return null;
  return savedPrompts.find((p) => norm(p.content) === text)?.id || cardSavePending.get(text) || null;
}

/** Draw the card again if it is still showing this rewrite, finished. */
function redrawCardFor(result) {
  if (cardResult === result && cardExpanded && cardState === "ready") showDiffModal(result);
}

/**
 * ⌘S or the bookmark on the card: saved in one press, no form.
 *
 * The form asks for a name and tags, which suits the library and is too much
 * on the card, where the rewrite is still being judged. From here the text is
 * saved alone. An unnamed prompt shows its own words in the library, so
 * nothing is named for the user, and a name can be given there later. The
 * bookmark fills in; pressing it again shows the prompt in the library. An
 * improved saved prompt is saved beside the original, under its name.
 */
async function saveCard() {
  const result = cardResult;
  const text = String(result?.enhanced || "").trim();
  if (!text || cardSaving) return;
  if (cardSavedId(result)) { showInLibrary(text); return; }
  const auth = await getAuth();
  if (!auth || isTokenExpired(auth.token)) {
    showToast("Sign in to save prompts to your library.", "info", { label: "Sign in", run: () => openSettings() });
    return;
  }
  if (!(await ensureDataConsent())) return;
  const subject = cardSubject;
  cardSaving = true;
  document.getElementById("pm-card-save")?.setAttribute("aria-busy", "true");
  const outcome = await createSavedPrompt(text, subject ? `${subject.title} (improved)` : "", []);
  cardSaving = false;
  document.getElementById("pm-card-save")?.removeAttribute("aria-busy");
  if (outcome === "failed") {
    showToast("Could not save. Check your connection and try again.", "error");
    return;
  }
  const id = lastSavedPromptId;
  if (id) cardSavePending.set(norm(text), id);
  redrawCardFor(result);
  if (outcome === "duplicate") {
    // Nothing was written, so nothing is refetched; the user is shown where it is.
    showToast("Already in your library", "info", { label: "Show", run: () => showInLibrary(text) });
    return;
  }
  statsBump("saves");
  tipDone("save");
  showToast(subject ? "Saved as a new prompt; the original is unchanged" : "Saved to your library", "success",
    id ? { label: "Undo", run: () => undoCardSave(result, id) } : null);
  await fetchSavedPrompts();
  cardSavePending.delete(norm(text));
  if (panelOpen) renderLibrary();
}

async function undoCardSave(result, id) {
  cardSavePending.delete(norm(result.enhanced));
  if (await undoSave(id)) redrawCardFor(result);
}

// ── Keymap ──
// Card shortcuts respect focus; Tab always keeps its navigation behavior.
/**
 * A modal or the voice overlay is up.
 *
 * Both black out the page and take over input, and both now outrank the card
 * in the stacking order — so the card is not just visually behind them, its
 * keys have to stop answering too. Tab accepting a rewrite the user cannot see,
 * because a full-screen backdrop is over it, is the same data loss the stale
 * card was about.
 */
function overlayHasInput() {
  return Boolean(
    document.querySelector(".pm-modal-overlay.pm-visible, #pm-voice.pm-visible")
  );
}

// Tab is always navigation. Other shortcuts only apply while focus belongs
// to the composer, pill, or card; ordinary typing never invokes card actions.
function handleCardKeydown(e) {
  if (e.key === "Tab" || e.isComposing || e.defaultPrevented) return;
  // Esc stops a recording, but folds a transcript under review: throwing
  // away words the user is reading is the bin button's job, not a key's.
  if (e.key === "Escape" && document.querySelector("#pm-voice.pm-visible")) {
    e.preventDefault(); e.stopPropagation();
    if (voiceState === "reviewing") foldVoice(true); else cancelVoice();
    return;
  }
  if (cardState === "idle" || overlayHasInput()) return;
  const card = document.getElementById("pm-card");
  const active = document.activeElement;
  const inCard = Boolean(card && active && card.contains(active));
  const pill = document.getElementById("pm-trigger");
  const inPill = Boolean(pill && active && pill.contains(active));
  if (!inCard && !inPill && !composerHasFocus()) return;
  const chord = (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyP";
  if (chord) {
    e.preventDefault(); e.stopPropagation();
    if (card && cardTucked) untuckCard(); else if (card) hideCard(); else expandCard();
    return;
  }
  if (!card) return;
  if (e.key === "Escape") {
    e.preventDefault(); e.stopPropagation();
    if (cardState === "ready") hideCard();
    else if (cardState === "streaming") cancelStreaming();
    else closeCard();
    return;
  }
  // ⌘S / Ctrl+S saves the rewrite on screen from the chat box too. It used to
  // answer only with focus inside the card, so pressed where people type it
  // fell through to the browser's Save page, on Windows and Mac alike. Taken
  // from the page only while there is a finished rewrite open to save.
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s" &&
      cardState === "ready" && cardExpanded) {
    e.preventDefault(); e.stopPropagation(); saveCard(); return;
  }
  // Redo and the version keys belong to the review controls, not the host's editor.
  if (!inCard || cardState !== "ready") return;
  if ((e.key === "[" || e.key === "]") && !e.metaKey && !e.ctrlKey && !e.altKey && cardVersions.length > 1) {
    e.preventDefault(); e.stopPropagation(); stepVersion(e.key === "]" ? 1 : -1); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault(); e.stopPropagation(); redoCard(); return;
  }
}
document.addEventListener("keydown", handleCardKeydown, true);
// Capture, so a host that stops the event cannot keep the card over its page.
// Wheel rather than scroll: a host auto-scrolling a streaming answer is not
// the user going back to the conversation.
document.addEventListener("wheel", tuckOnPageGesture, { capture: true, passive: true });
document.addEventListener("pointerdown", tuckOnPageGesture, true);

function showSetupRequiredModal() {
  const overlay = getOrCreateModalOverlay();
  const modal = overlay.querySelector(".pm-modal");

  modal.innerHTML = `
    <div class="pm-modal-header">
      <span class="pm-modal-title">One-time setup</span>
      <button class="pm-header-close pm-modal-close-btn">×</button>
    </div>
    <div class="pm-modal-body">
      <p class="pm-setup-intro">One step before your first rewrite: choose what does the rewriting. Both are free, and your draft stays as it is.</p>

      <div class="pm-setup-option pm-setup-option-primary">
        <div class="pm-setup-badge">Quickest</div>
        <div class="pm-setup-title">Sign in with Google</div>
        <div class="pm-setup-desc">15 free rewrites a day, and your saved prompts and History on every computer.</div>
        <button class="pm-btn pm-btn-primary" id="pm-setup-signin">Continue with Google</button>
      </div>

      <div class="pm-setup-option">
        <div class="pm-setup-badge">Most private</div>
        <div class="pm-setup-title">Use your own free key</div>
        <div class="pm-setup-desc">No account with us: your drafts go straight to the AI provider. Getting a free Groq key takes about a minute.</div>
        <button class="pm-btn pm-btn-secondary" id="pm-setup-byok">Add a free key</button>
      </div>
    </div>
  `;

  modal.querySelectorAll(".pm-modal-close-btn").forEach((b) =>
    b.addEventListener("click", closeModal)
  );
  // A content script still cannot open the ACTION popup — but it can ask the
  // service worker to open the options page, which is the same UI. These two
  // buttons used to close the modal and tell the user to go find the toolbar
  // icon themselves, which is a dead end at the exact moment they had agreed
  // to set the product up.
  modal.querySelector("#pm-setup-byok")?.addEventListener("click", () => {
    closeModal();
    openSettings("key");
  });
  modal.querySelector("#pm-setup-signin")?.addEventListener("click", () => {
    closeModal();
    openSettings("signin");
  });

  // Without this the modal is built, inserted, wired up — and never shown.
  // .pm-modal-overlay is opacity:0/visibility:hidden until .pm-visible is
  // added, which every other modal does and this one did not. The effect was
  // that a new user with no account and no API key typed a prompt, pressed
  // Enhance, and got absolutely nothing: no modal, no toast, no error. That is
  // the first interaction every single new install has with this product.
  overlay.classList.add("pm-visible");
}

// ══════════════════════════════════════════════════════════════
// DIFF PREVIEW MODAL — Shows original vs enhanced
// ══════════════════════════════════════════════════════════════

// Re-enhance with edited original prompt
let reEnhanceCooldown = false;

async function handleReEnhance(editedText, originalText) {
  if (!editedText || editedText.length < 3) {
    showToast("Prompt too short — need at least 3 characters.", "error");
    return;
  }
  if (editedText === originalText) {
    showToast("No changes made — edit the text first.", "info");
    return;
  }
  if (reEnhanceCooldown) {
    showToast("Please wait a moment before re-enhancing.", "info");
    return;
  }

  const btn = document.getElementById("pm-reenhance-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Enhancing...";
  }

  reEnhanceCooldown = true;
  setTimeout(() => { reEnhanceCooldown = false; }, 2000);

  showToast(`Re-enhancing in ${currentMode} mode...`, "info");

  const newResult = await enhancePrompt(editedText, Array.from(selectedIds));

  if (!newResult) {
    showToast("Re-enhancement failed. Check connection.", "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Re-Enhance ↻";
    }
    return;
  }

  lastEnhanceResult = newResult;
  showDiffModal(newResult);
  showToast("Prompt re-enhanced!", "success");
}

// ══════════════════════════════════════════════════════════════
// SMART SAVE + FEEDBACK TOASTS
// ══════════════════════════════════════════════════════════════

/**
 * The one place toasts live.
 *
 * Every toast used to position itself: `position: fixed; bottom: 80px; left:
 * 50%`, identically, on every instance. Two at once therefore landed on the
 * same pixels — which is exactly what accepting a rewrite did, firing the
 * "Applied" confirmation and the rating prompt together, the rating prompt
 * covering the confirmation outright.
 */
function getOrCreateToastStack() {
  let stack = document.getElementById("pm-toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "pm-toast-stack";
    document.body.appendChild(stack);
  }
  // Toasts never carried a theme at all — they read :root, so they rendered
  // dark for everyone regardless of the setting. Read on every show rather than
  // once at creation, so a mid-session theme change is picked up.
  storageGet("pm_theme", (r) =>
    stack.setAttribute("data-pm-theme", r.pm_theme || "dark")
  );
  return stack;
}

// Attached once, for the life of the page. positionToasts() is a no-op while
// no toast is up, so there is nothing to tear down and nothing to leak.
window.addEventListener("resize", () => positionToasts(), true);
window.addEventListener("scroll", () => positionToasts(), true);

/**
 * Sit the stack above whatever the toast is talking about.
 *
 * Pinned to `bottom: 80px`, a toast raised while the card was open rendered
 * behind it — the card outranks the old toast z-index by six orders of
 * magnitude — so ⌘S showed a sliver of "Saved to your library" poking out from
 * under the card it was confirming.
 */
function positionToasts() {
  const stack = document.getElementById("pm-toast-stack");
  if (!stack || !stack.firstChild) return;
  const gap = 10, margin = 12;
  const vw = window.innerWidth, vh = window.innerHeight;

  // Beside the pill, on its side of the window: the notice is about the
  // extension's own action, and it belongs by the extension. Centred over
  // the chat box it sat on the context chips and the last lines of the
  // conversation (a tester called it out as covering what they were reading).
  const pill = document.getElementById("pm-trigger")?.getBoundingClientRect();
  const right = !pill || pill.left + pill.width / 2 > vw / 2;
  stack.style.transform = "none";
  stack.style.alignItems = right ? "flex-end" : "flex-start";
  stack.style.left = right ? "auto" : Math.max(margin, Math.round(pill.left)) + "px";
  stack.style.right = right ? Math.max(margin, Math.round(vw - (pill ? pill.right : vw - margin))) + "px" : "auto";
  const width = stack.offsetWidth || 320;
  const colLeft = right ? vw - parseFloat(stack.style.right) - width : parseFloat(stack.style.left);
  const height = stack.offsetHeight || 44;

  // Above the pill, and above whatever of ours or the chat box stands in
  // that column: the card, the open library, the save form, the chips, the
  // box itself. Highest first wins, so it clears the whole stack.
  let floor = pill ? pill.top : vh - 80;
  const obstacles = [document.getElementById("pm-card"), document.getElementById("pm-library"),
    document.getElementById("pm-save"), document.getElementById("pm-rail")]
    .filter((el) => el && !el.hidden).map((el) => el.getBoundingClientRect());
  const box = composerFrame(findComposer());
  if (box) obstacles.push(box);
  for (let pass = 0; pass < obstacles.length; pass++) {
    for (const o of obstacles) {
      if (!o.width || o.right <= colLeft || o.left >= colLeft + width) continue;
      if (o.top < floor && o.bottom > floor - height - gap) floor = o.top;
    }
  }
  stack.style.top = Math.max(margin, Math.round(floor - gap - height)) + "px";
}

/** Fade a toast out and take it out of the stack. */
function dismissToast(toast) {
  toast.classList.remove("pm-toast-visible");
  setTimeout(() => {
    toast.remove();
    const stack = document.getElementById("pm-toast-stack");
    if (stack && !stack.firstChild) stack.remove();
  }, 250);
}

// The rating question after an accepted rewrite lives in the pill: see
// showApplied() / ratePill().

function showToast(message, type = "info", action = null) {
  document.getElementById("pm-toast")?.remove();

  const stack = getOrCreateToastStack();
  const toast = document.createElement("div");
  toast.id = "pm-toast";
  toast.className = `pm-toast pm-toast-${type}`;
  toast.textContent = message;
  // One optional action, such as Undo. It stays up longer, so it can be used.
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pm-toast-action";
    b.textContent = action.label;
    b.addEventListener("click", () => { dismissToast(toast); action.run(); }, { once: true });
    toast.appendChild(b);
  }

  // Before the feedback toast when both are up, so the plain status line reads
  // first and the thing with buttons sits nearest the card.
  stack.insertBefore(toast, stack.firstChild);
  positionToasts();
  requestAnimationFrame(() => {
    toast.classList.add("pm-toast-visible");
    positionToasts();
  });

  setTimeout(() => dismissToast(toast), action ? 8000 : 3000);
}

// ══════════════════════════════════════════════════════════════
// NEW / EDIT PROMPT: a page of the library
// ══════════════════════════════════════════════════════════════
//
// It was a window of its own: the whole page blurred behind it, a gradient
// Save, and the look of nothing else in the extension. It is now a page of
// the sheet, in the sheet's own fields and buttons (the ones the save form
// uses), with the tags already in use one click away.

/**
 * + New: a prompt written from scratch. A draft in the chat box starts it
 * off, since that is usually what the user wants to keep.
 */
function openNewPrompt() {
  openPromptPage({ content: String(getCurrentInputText() || "").trim(), title: "", tags: [] });
}

/** The page, for a saved prompt or (with no id) a new one. */
function openPromptPage(prompt) {
  if (!panelOpen) togglePanel(true);
  libEdit = {
    id: prompt.id ?? null,
    original: prompt,
    content: prompt.content || "",
    title: prompt.title || "",
    tags: new Set(prompt.tags || []),
    tagText: "",
    busy: false,
    status: "",
    error: false,
  };
  libPage = "edit";
  libMenu = false;
  libRowMenu = null;
  libConfirm = null;
  hidePeek();
  renderLibrary();
  const ta = document.getElementById("pm-edit-content");
  ta?.focus({ preventScroll: true });
  ta?.setSelectionRange(ta.value.length, ta.value.length);
}

function libEditHtml() {
  const e = libEdit;
  const tags = [...new Set([...savedTagSuggestions(8), ...e.tags])];
  const status = e.status
    ? escHtml(e.status)
    : `<kbd>${CMD_ENTER}</kbd>save<kbd>esc</kbd>back`;
  return `<div class="pm-lib-page pm-lib-edit">` +
    `<textarea id="pm-edit-content" class="pm-lib-input pm-edit-text" rows="5" spellcheck="true" ` +
    `placeholder="The prompt you want to reuse" aria-label="Prompt">${escHtml(e.content)}</textarea>` +
    `<label class="pm-save-field"><span>Name</span><input id="pm-edit-title" class="pm-lib-input" type="text" maxlength="120" ` +
    `autocomplete="off" spellcheck="false" value="${escHtml(e.title)}" placeholder="Optional. Unnamed prompts show their words"></label>` +
    `<div class="pm-save-field"><span>Tags</span>` +
    (tags.length
      ? `<div class="pm-save-tags">${tags.map((t) =>
          `<button type="button" data-tag="${escHtml(t)}" aria-pressed="${e.tags.has(t)}">#${escHtml(t)}</button>`).join("")}</div>`
      : "") +
    `<input id="pm-edit-tags" class="pm-lib-input" type="text" autocomplete="off" spellcheck="false" value="${escHtml(e.tagText)}" ` +
    `placeholder="New tags, comma separated" aria-label="New tags"></div>` +
    `<div class="pm-save-foot"><span class="pm-save-status${e.error ? " pm-save-error" : ""}" id="pm-edit-status" role="status">${status}</span>` +
    `<button type="button" class="pm-lib-verb pm-lib-verb-quiet" id="pm-edit-cancel" data-act="editcancel">Cancel</button>` +
    `<button type="button" class="pm-lib-verb" id="pm-edit-save" data-act="editsave"${e.busy ? " disabled" : ""}>` +
    `${e.busy ? "Saving\u2026" : e.id != null ? "Save changes" : "Save"}</button></div></div>`;
}

/** Back to the list, nothing saved. */
function leavePromptPage() {
  libEdit = null;
  libPage = "list";
  renderLibrary();
  focusLibrarySearch();
}

/** Show a problem on the page, and give the keyboard back to `focusId`. */
function promptPageSays(e, message, focusId = "") {
  e.status = message;
  e.error = true;
  renderLibrary();
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
}

async function savePromptPage() {
  const e = libEdit;
  if (!e || e.busy) return;
  const content = e.content.trim();
  const title = e.title.trim();
  const typed = e.tagText.split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
  const tags = [...new Set([...e.tags, ...typed])];
  if (!content) { promptPageSays(e, "Write the prompt first.", "pm-edit-content"); return; }

  if (e.id == null) {
    e.busy = true;
    e.status = ""; e.error = false;
    renderLibrary();
    const outcome = await createSavedPrompt(content, title, tags);
    if (libEdit !== e) return;   // left the page while the request was out
    e.busy = false;
    if (outcome === "failed") { promptPageSays(e, "Could not save. Check your connection and try again."); return; }
    libEdit = null;
    libPage = "list";
    if (outcome === "duplicate") {
      renderLibrary();
      focusLibrarySearch();
      showToast("Already in your library", "info", { label: "Show", run: () => showInLibrary(content) });
      return;
    }
    const id = lastSavedPromptId;
    statsBump("saves");
    tipDone("save");
    showToast(title ? `Saved \u201c${clipText(title, 40)}\u201d to your library` : "Saved to your library",
      "success", id ? { label: "Undo", run: () => undoSave(id) } : null);
    // Back to the list at once; it is drawn again, the new prompt picked out,
    // once the library has it.
    renderLibrary();
    focusLibrarySearch();
    await fetchSavedPrompts();
    if (panelOpen && libPage === "list") {
      libView = "saved";
      searchQuery = "";
      const at = libraryItems().findIndex((it) => it.p?.id === id);
      libSel = at >= 0 ? at : 0;
      renderLibrary();
      focusLibrarySearch();
    }
    return;
  }

  const p = e.original;
  const fields = {};
  if (content !== p.content) fields.content = content;
  if (title !== (p.title || "")) fields.title = title || null;
  if (JSON.stringify(tags) !== JSON.stringify(p.tags || [])) fields.tags = tags;
  if (!Object.keys(fields).length) { leavePromptPage(); return; }
  e.busy = true;
  e.status = ""; e.error = false;
  renderLibrary();
  const ok = await updateSavedPrompt(p.id, fields);
  if (libEdit !== e) return;
  e.busy = false;
  // The window this replaces closed on a failed save as if it had worked.
  if (!ok) { promptPageSays(e, "Could not save the changes. Check your connection and try again."); return; }
  libEdit = null;
  libPage = "list";
  renderLibrary();
  focusLibrarySearch();
  await fetchSavedPrompts();
  if (panelOpen && libPage === "list") renderLibrary();
}

// ══════════════════════════════════════════════════════════════
// GENERIC MODAL
// ══════════════════════════════════════════════════════════════

function showModal(title, body, buttons = []) {
  const overlay = getOrCreateModalOverlay();
  const modal = overlay.querySelector(".pm-modal");

  const footerBtns = buttons
    .map(
      (b, i) =>
        `<button class="pm-btn pm-btn-${b.style || "primary"}" data-idx="${i}">${escHtml(b.label)}</button>`
    )
    .join("");

  modal.innerHTML = `
    <div class="pm-modal-header">
      <span class="pm-modal-title">${escHtml(title)}</span>
      <button class="pm-header-close pm-modal-close-btn">×</button>
    </div>
    <div class="pm-modal-body pm-modal-text">${escHtml(body)}</div>
    <div class="pm-modal-footer">${footerBtns}</div>
  `;

  overlay.querySelector(".pm-modal-close-btn").addEventListener("click", closeModal);

  buttons.forEach((b, i) => {
    const el = modal.querySelector(`[data-idx="${i}"]`);
    if (b.action === "close") {
      el.addEventListener("click", closeModal);
    } else if (typeof b.action === "function") {
      el.addEventListener("click", b.action);
    }
  });

  overlay.classList.add("pm-visible");
}

let consentRequest = null;
async function ensureDataConsent() {
  if (dataConsent) return true;
  const stored = await new Promise((resolve) =>
    storageGet("pm_data_consent_v1", (result) => resolve(result.pm_data_consent_v1 === true))
  );
  if (stored) { dataConsent = true; return true; }
  if (consentRequest) return consentRequest;

  consentRequest = new Promise((resolve) => {
    const overlay = getOrCreateModalOverlay();
    const modal = overlay.querySelector(".pm-modal");
    modal.innerHTML = `
      <div class="pm-modal-header"><span class="pm-modal-title">How Prompt Memory handles your data</span></div>
      <div class="pm-modal-body pm-consent-body">
        <p><strong>Only when you ask:</strong> Enhance sends your draft to an AI provider. When signed in, our server also receives it, saves the draft and rewrite in History, and includes up to six recent chat messages for context by default. You can switch that context off in the Library: ⋯ → Privacy settings.</p>
        <p><strong>Your own key:</strong> Without sign-in, the draft goes directly from your browser to the provider. If you also sign in, the key is forwarded through our server for each enhancement request so memory features can work.</p>
        <p><strong>Other choices:</strong> Sign-in shares your Google email with us. Voice sends audio to our server and Groq when you record. Prompt Tracking logs submitted prompts only if you turn it on.</p>
        <a href="https://prompt-engineering-skeleton-seven.vercel.app/privacy" target="_blank" rel="noreferrer">Read the full privacy policy</a>
      </div>
      <div class="pm-modal-footer">
        <button class="pm-btn pm-btn-secondary" id="pm-consent-cancel">Not now</button>
        <button class="pm-btn pm-btn-primary" id="pm-consent-accept">Agree &amp; continue</button>
      </div>`;

    const finish = (accepted) => {
      overlay.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onEscape, true);
      closeModal();
      resolve(accepted);
    };
    const onBackdrop = (event) => { if (event.target === overlay) finish(false); };
    const onEscape = (event) => { if (event.key === "Escape") finish(false); };
    overlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onEscape, true);
    modal.querySelector("#pm-consent-cancel").addEventListener("click", () => finish(false));
    modal.querySelector("#pm-consent-accept").addEventListener("click", () => {
      storageSet({ pm_data_consent_v1: true }, (saved) => {
        if (!saved) { finish(false); return; }
        dataConsent = true;
        finish(true);
      });
    });
    overlay.classList.add("pm-visible");
    modal.querySelector("#pm-consent-accept").focus();
  }).finally(() => { consentRequest = null; });
  return consentRequest;
}

function getOrCreateModalOverlay() {
  let overlay = document.getElementById("pm-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "pm-modal-overlay";
    overlay.className = "pm-modal-overlay";
    // Modals are lazy-created after the panel usually applies the saved theme.
    // Copy it now so a light-themed session does not fall back to dark :root
    // tokens before the next theme toggle.
    overlay.setAttribute(
      "data-pm-theme",
      uiTheme
    );
    overlay.innerHTML = `<div class="pm-modal"></div>`;
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeModal();
    });
    document.body.appendChild(overlay);
  }
  return overlay;
}

function closeModal() {
  const overlay = document.getElementById("pm-modal-overlay");
  if (overlay) overlay.classList.remove("pm-visible");
}

// ══════════════════════════════════════════════════════════════
// INPUT DETECTION & PASSIVE TRACKING
// ══════════════════════════════════════════════════════════════

// The chat box's selectors live in sites.js with every other site-specific
// one, most- to least-specific; each candidate is checked for visibility
// before it is taken (isUsable).
const COMPOSER_SELECTORS = PM_SITES.composer;

function isUsable(el) {
  if (!el || el.offsetParent === null) return false;
  if (el.disabled || el.readOnly) return false;
  if (el.getAttribute?.("aria-hidden") === "true") return false;
  const r = el.getBoundingClientRect();
  return r.width > 40 && r.height > 10;
}

/** The composer both reading and writing must agree on. */
function findComposer() {
  for (const sel of COMPOSER_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      if (isUsable(el)) return el;
    }
  }
  return null;
}

function composerText(el) {
  if (!el) return "";
  return el.tagName === "TEXTAREA" || el.tagName === "INPUT"
    ? el.value || ""
    : el.innerText || "";
}

function getCurrentInputText() {
  return composerText(findComposer());
}

const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
const clipText = (s, n) => { const t = norm(s); return t.length > n ? t.slice(0, n - 1) + "\u2026" : t; };

/**
 * Write text into the page's composer. Returns true only if it actually stuck.
 *
 * The old version assigned `el.value = text` (or `el.innerText`) and returned
 * nothing. Both halves of that were wrong:
 *
 *  - React tracks the last value it wrote to an input in an internal
 *    `_valueTracker`. A direct assignment updates the DOM but leaves the
 *    tracker unchanged, so React's synthetic `input` handler sees no change,
 *    never updates state, and re-renders the ORIGINAL text back. Going through
 *    the native prototype setter is what makes the tracker observe the write.
 *  - ChatGPT and Claude use ProseMirror/Lexical, which keep their own document
 *    model. Assigning `innerText` mutates the rendered DOM underneath the model
 *    and is discarded on the editor's next render. `insertText` via execCommand
 *    goes through the real beforeinput/input pipeline the editor listens on.
 *
 * Returning void was the more damaging half: the caller closed the modal and
 * showed a success toast regardless, so a failed write looked identical to a
 * successful one — and the user pressed Enter and sent their ORIGINAL prompt
 * believing it had been replaced.
 */
/**
 * Wait for a framework re-render to have had a chance to run.
 *
 * Two animation frames, but raced against a timer: requestAnimationFrame does
 * not fire at all in a background tab, and this sits on the await path of
 * "Use This Prompt". Without the race, enhancing in a tab the user has since
 * switched away from would hang that promise forever — the modal would never
 * close and the enhancement would be stuck behind a callback that never runs.
 */
function nextFrame(timeoutMs = 120) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, timeoutMs);
  });
}

function selectAllIn(el) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Empty the composer before writing into it.
 *
 * Selecting the contents is not enough everywhere: on Perplexity an insert over
 * a full selection appends rather than replaces, so the user ends up with their
 * prompt twice. Deleting the selection first makes the write a replacement on
 * every editor tested, and costs nothing where the selection would have been
 * replaced anyway.
 */
async function clearComposer(el) {
  el.focus();
  selectAllIn(el);
  // Editors that keep their own model of the selection (Lexical) learn of a
  // programmatic one from selectionchange, a beat later. Deleting at once
  // deleted nothing in their model, execCommand's DOM edit was then reverted,
  // and the insert that followed landed after the old text: the chat box
  // ended up holding its text and the rewrite twice.
  await nextFrame();
  // Ask the way a real delete key does. An editor that handles it cancels the
  // event and deletes through its own state; one that does not leaves it to
  // execCommand, as before.
  const handled = !el.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true, cancelable: true, inputType: "deleteContentBackward",
  }));
  if (handled) { await nextFrame(); return; }
  try {
    if (document.execCommand("delete", false)) return;
  } catch { /* fall through */ }
  if (norm(composerText(el))) el.textContent = "";
}

/**
 * Insertion strategies for rich-text composers, tried in order.
 *
 * Which one works depends on how the editor watches for changes, and the big
 * two do it differently: ProseMirror (ChatGPT) reconciles from a
 * MutationObserver, Lexical and friends act on `beforeinput`. Verified in
 * Chrome: document.execCommand("insertText") fires `input` but does NOT fire
 * `beforeinput`, so an editor that only listens to the latter never learns
 * about the text and reverts it on the next render.
 */
const INSERT_STRATEGIES = [
  function viaBeforeInput(el, text) {
    // Dispatched explicitly because execCommand does not raise it. If the
    // editor handles and cancels it, it has done the insertion itself and
    // execCommand must not run as well or the text lands twice.
    const notCancelled = el.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true, cancelable: true,
      inputType: "insertReplacementText", data: text,
    }));
    if (notCancelled) document.execCommand("insertText", false, text);
  },

  function viaPaste(el, text) {
    // Every serious editor implements paste, which makes this the best
    // fallback when the editor ignored the events above.
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: dt, bubbles: true, cancelable: true,
    }));
  },

  function viaTextContent(el, text) {
    // Plain contenteditable with no framework behind it.
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", {
      bubbles: true, inputType: "insertText", data: text,
    }));
  },
];

function composerMatches(el, text) {
  const after = norm(composerText(el));
  const want = norm(text);
  if (after === want) return true;

  // The tolerance below exists for editors that reflow whitespace, and it used
  // to be `after.includes(want.slice(0, 40))`. That is true of DUPLICATED text
  // too — and on Perplexity, selecting the composer's contents does not replace
  // them, so an insert appends and the box ends up holding the message twice.
  // The old check called that a success, which is precisely the failure this
  // function exists to catch. Length has to stay in the same ballpark.
  return (
    want.length > 40 &&
    after.startsWith(want.slice(0, 40)) &&
    after.length <= Math.round(want.length * 1.15)
  );
}

/**
 * Write text into the page's composer. Resolves true only if it actually stuck.
 *
 * The old version assigned `el.value = text` (or `el.innerText`) and returned
 * nothing. Both halves of that were wrong:
 *
 *  - React tracks the last value it wrote to an input in an internal
 *    `_valueTracker`. A direct assignment updates the DOM but leaves the
 *    tracker unchanged, so React's synthetic `input` handler sees no change,
 *    never updates state, and re-renders the ORIGINAL text back. Going through
 *    the native prototype setter is what makes the tracker observe the write.
 *  - ChatGPT and Claude use ProseMirror/Lexical, which keep their own document
 *    model. Assigning `innerText` mutates the rendered DOM underneath the model
 *    and is discarded on the editor's next render.
 *
 * Returning void was the more damaging half: the caller closed the modal and
 * showed a success toast regardless, so a failed write looked identical to a
 * successful one — and the user pressed Enter and sent their ORIGINAL prompt
 * believing it had been replaced.
 *
 * Verification waits a frame before reading back. Checking synchronously
 * reports success for a write the editor is about to revert, which reproduces
 * the original bug with extra steps.
 */
async function applyToInput(text) {
  const el = findComposer();
  if (!el) return false;

  try {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      el.focus();
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await nextFrame();
      return norm(el.value) === norm(text);
    }

    for (const strategy of INSERT_STRATEGIES) {
      await clearComposer(el);
      selectAllIn(el);
      await nextFrame();   // the same beat, for the insert's selection
      try {
        strategy(el, text);
      } catch {
        continue;         // strategy unavailable in this browser; try the next
      }
      await nextFrame();
      if (composerMatches(el, text)) return true;
    }
    return false;
  } catch (err) {
    console.warn("Prompt Memory: could not write to the composer", err);
    return false;
  }
}

/**
 * Apply, and when the page refuses the write, put the text somewhere the user
 * can still get at it rather than losing the enhancement silently.
 */
async function applyOrFallback(text, successMessage = "Prompt applied to input!") {
  if (await applyToInput(text)) {
    // A null message means the caller shows its own confirmation. Without this,
    // acceptCard raised two toasts for one event and they landed on each other.
    if (successMessage) showToast(successMessage, "success");
    return true;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("Couldn't update the chat box — copied to your clipboard instead.", "error");
  } catch {
    showToast("Couldn't update the chat box. Copy the text from the panel.", "error");
  }
  return false;
}

/**
 * x.com matches only /i/grok, but a content script keeps running after a
 * client-side navigation away from it. Without this check the tracker stayed
 * live while the user moved on to DMs, the tweet composer and search — none of
 * which the extension has any business recording.
 */
function onTrackableSurface() {
  if (window.location.hostname !== "x.com") return true;
  return window.location.pathname.startsWith("/i/grok");
}

function setupPassiveTracking() {
  let lastText = "";

  document.addEventListener("input", (e) => {
    if (orphaned || !extensionAlive()) { onOrphaned(); return; }
    if (!promptTrackingEnabled || !onTrackableSurface()) return;
    const el = e.target;
    if (
      el.matches("#prompt-textarea, [contenteditable='true'], textarea") &&
      el.offsetParent !== null
    ) {
      lastText = el.innerText || el.value || "";
    }
  }, true);

  document.addEventListener("keydown", (e) => {
    if (orphaned || !extensionAlive()) { onOrphaned(); return; }
    if (!promptTrackingEnabled || !onTrackableSurface()) return;
    if (e.key === "Enter" && !e.shiftKey && lastText.trim().length > 5) {
      trackPrompt(lastText);
      lastText = "";
    }
  }, true);

  document.addEventListener("click", (e) => {
    if (orphaned || !extensionAlive()) { onOrphaned(); return; }
    if (!promptTrackingEnabled || !onTrackableSurface()) return;
    const btn = e.target.closest("button");
    if (
      btn &&
      !btn.classList.contains("pm-trigger") &&
      !btn.closest("#pm-library, #pm-rail, #pm-caret") &&
      !btn.closest("#pm-modal-overlay") &&
      lastText.trim().length > 5
    ) {
      const nearInput = btn.closest("form") || btn.parentElement;
      if (nearInput && nearInput.querySelector("textarea, [contenteditable='true']")) {
        trackPrompt(lastText);
        lastText = "";
      }
    }
  }, true);
}

// ══════════════════════════════════════════════════════════════
// VOICE-TO-PROMPT ENGINE (MediaRecorder → Groq Whisper → LLM)
// ══════════════════════════════════════════════════════════════

const VOICE_MAX_RECORDING_SECONDS = 120;
let mediaRecorder = null;
let mediaStream = null;
let audioChunks = [];
let recordingStartTime = 0;
let recordingTimer = null;
let voiceStopTimer = null;
let voiceAbortController = null;
let voiceDiscardRecording = false;
let voiceRecordingDurationSeconds = 0;
let voiceDetectedLanguage = "unknown";
let voiceComposerBaseline = "";

function supportedVoiceMimeType() {
  if (!window.MediaRecorder?.isTypeSupported) return "";
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
    .find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function releaseVoiceCapture() {
  clearInterval(recordingTimer);
  clearTimeout(voiceStopTimer);
  recordingTimer = null;
  voiceStopTimer = null;
  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  mediaRecorder = null;
  isRecording = false;
  updateVoiceUI(false);
}

function cleanupVoice({ hideOverlay = true } = {}) {
  voiceAbortController?.abort();
  voiceAbortController = null;
  audioChunks = [];
  voiceDiscardRecording = false;
  voiceRecordingDurationSeconds = 0;
  voiceDetectedLanguage = "unknown";
  voiceComposerBaseline = "";
  voiceState = "idle";
  releaseVoiceCapture();
  if (hideOverlay) hideVoiceOverlay();
}

async function getVoiceAuthToken() {
  const auth = await getAuth();
  if (!auth || isTokenExpired(auth.token)) {
    showToast("Voice transcription requires signing in first.", "error");
    openSettings();
    return null;
  }
  if (tokenExpiresWithinDays(auth.token, 2)) {
    return (await tryRefreshToken(auth)) || auth.token;
  }
  return auth.token;
}

function toggleVoice() {
  if (orphaned || !extensionAlive()) { onOrphaned(); return; }
  if (voiceState === "recording") return stopVoice();
  if (voiceState === "idle") return startVoice();
  if (voiceState === "reviewing") return cancelVoice();
}

async function startVoice() {
  if (!(await ensureDataConsent())) return;
  if (voiceState !== "idle") return;
  const token = await getVoiceAuthToken();
  if (!token) return;
  // A voice result may replace the composer only if it has not changed since
  // recording began. An empty composer is a real, valid baseline—not a signal
  // to skip the stale-write guard.
  voiceComposerBaseline = norm(getCurrentInputText());

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showToast("Voice recording is not supported by this browser.", "error");
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    const detail = error?.name === "NotFoundError"
      ? "No microphone was found. Connect one and try again."
      : "Microphone access was denied. Allow it in browser settings and try again.";
    showToast(detail, "error");
    return;
  }

  audioChunks = [];
  voiceDiscardRecording = false;
  const mimeType = supportedVoiceMimeType();
  try {
    mediaRecorder = mimeType
      ? new MediaRecorder(mediaStream, { mimeType })
      : new MediaRecorder(mediaStream);
  } catch (error) {
    releaseVoiceCapture();
    showToast("This browser could not start an audio recording.", "error");
    return;
  }

  mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) audioChunks.push(event.data);
  };
  mediaRecorder.onstop = () => {
    void finishVoiceRecording(token, mediaRecorder?.mimeType || mimeType || "audio/webm");
  };
  mediaRecorder.onerror = () => {
    voiceDiscardRecording = true;
    audioChunks = [];
    voiceState = "idle";
    releaseVoiceCapture();
    hideVoiceOverlay();
    showToast("Recording stopped unexpectedly. Please try again.", "error");
  };

  try {
    mediaRecorder.start(250);
  } catch (error) {
    cleanupVoice();
    showToast("Could not start recording. Please try again.", "error");
    return;
  }

  voiceState = "recording";
  isRecording = true;
  recordingStartTime = Date.now();
  updateVoiceUI(true);
  showVoiceOverlay();

  recordingTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const timerEl = document.getElementById("pm-voice-timer");
    if (timerEl) timerEl.textContent = voiceClock(elapsed);
  }, 1000);
  voiceStopTimer = setTimeout(() => {
    if (voiceState !== "recording") return;
    showToast(`Recording limit reached (${VOICE_MAX_RECORDING_SECONDS}s). Preparing your transcript…`, "info");
    stopVoice();
  }, VOICE_MAX_RECORDING_SECONDS * 1000);

}

function stopVoice() {
  if (voiceState !== "recording" || !mediaRecorder || mediaRecorder.state === "inactive") return;
  voiceState = "stopping";
  isRecording = false;
  updateVoiceUI(false);
  try {
    mediaRecorder.stop();
  } catch (error) {
    cleanupVoice();
    showToast("Could not stop the recording. Please try again.", "error");
  }
}

function cancelVoice() {
  const wasRecording = voiceState === "recording" || voiceState === "stopping";
  voiceDiscardRecording = true;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try {
      voiceState = "stopping";
      mediaRecorder.stop();
      if (wasRecording) showToast("Voice recording discarded.", "info");
      return;
    } catch { /* cleanup below */ }
  }
  cleanupVoice();
  if (wasRecording) showToast("Voice recording discarded.", "info");
}

async function finishVoiceRecording(token, mimeType) {
  const chunks = audioChunks;
  audioChunks = [];
  const durationSeconds = Math.max(0, (Date.now() - recordingStartTime) / 1000);
  const discarded = voiceDiscardRecording;
  releaseVoiceCapture();

  if (discarded) {
    cleanupVoice();
    return;
  }
  if (!chunks.length) {
    cleanupVoice();
    showToast("No audio was recorded. Please try again.", "error");
    return;
  }

  voiceState = "transcribing";
  voiceRecordingDurationSeconds = durationSeconds;
  updateVoiceOverlayState("transcribing");
  await transcribeVoiceAudio(new Blob(chunks, { type: mimeType }), token, durationSeconds);
}

async function transcribeVoiceAudio(audioBlob, token, durationSeconds) {
  const formData = new FormData();
  formData.append("audio", audioBlob, "recording.webm");
  formData.append("platform", window.location.hostname);
  formData.append("recording_duration_seconds", durationSeconds.toFixed(3));

  // The service worker owns the BYOK secret. A signed-in Groq BYOK user can
  // spend their own transcription quota without exposing the key to the host page.
  const byok = await askWorker({ type: "PM_GET_BYOK_FOR_BACKEND" });
  if (byok?.key) {
    formData.append("byok_provider", byok.provider || "");
    formData.append("byok_key", byok.key);
  }

  voiceAbortController = new AbortController();
  try {
    const response = await fetch(`${API_URL}/voice-transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
      signal: voiceAbortController.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      throw new Error(data.detail || "Voice transcription failed. Please try again.");
    }
    if (voiceState !== "transcribing") return; // cancelled while the request was in flight

    voiceDetectedLanguage = data.detected_language || "unknown";
    showVoiceTranscriptReview(data.transcription || "");
  } catch (error) {
    if (error?.name === "AbortError") return;
    cleanupVoice();
    console.error("Voice transcription error:", error);
    showToast(error?.message || "Voice transcription failed. Check your connection.", "error");
  } finally {
    voiceAbortController = null;
  }
}

/**
 * The transcript to look over, in a card on the chat box: what was heard,
 * editable, then Improve it, use it as it is, or throw it away. It was a
 * window over the whole page, blurred behind, with the time the transcription
 * took and a gradient button. On a small window it starts folded to one line,
 * so it never takes the screen; the line opens it again.
 */
function showVoiceTranscriptReview(transcript) {
  if (!transcript.trim()) {
    cleanupVoice();
    showToast("Could not understand the recording. Please try again.", "error");
    return;
  }
  voiceState = "reviewing";
  const el = document.getElementById("pm-voice");
  if (!el) return;
  const lang = voiceDetectedLanguage && voiceDetectedLanguage !== "unknown" ? ` \u00b7 ${escHtml(voiceDetectedLanguage.toUpperCase())}` : "";
  el.className = "pm-card pm-voice pm-voice-review pm-card-visible pm-visible";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Your words, to review");
  el.innerHTML =
    `<div class="pm-card-head"><span class="pm-card-head-dot" aria-hidden="true"></span>` +
    `<span class="pm-card-title">Your words${lang}</span>` +
    `<button class="pm-card-min" type="button" id="pm-voice-min" data-pm-tip="Fold to one line" data-pm-key="Esc" aria-label="Fold to one line">${CARD_MIN_SVG}</button></div>` +
    `<textarea id="pm-voice-transcript" class="pm-voice-text" rows="3" spellcheck="true" aria-label="Transcript">${escHtml(transcript)}</textarea>` +
    `<p class="pm-voice-note">Edit anything first. Nothing goes in the chat box until you choose.</p>` +
    cardFoot([
      `<button class="pm-card-act pm-card-btn pm-card-primary" id="pm-voice-enhance" type="button" data-pm-tip="Rewrite it as a prompt" data-pm-key="${CMD_ENTER}">${CARD_SPARK_SVG}Improve</button>`,
      CARD_SEP,
      `<button class="pm-card-act pm-card-btn pm-voice-plain" id="pm-voice-draft" type="button" data-pm-tip="Put your words in the chat box as they are">Use as is</button>`,
      CARD_SEP,
      `<button class="pm-card-act pm-card-icon pm-card-discard" id="pm-voice-cancel" type="button" aria-label="Discard the transcript" data-pm-tip="Discard the transcript">${CARD_DISCARD_SVG}</button>`,
    ]) +
    `<div class="pm-card-strip pm-voice-strip" id="pm-voice-strip"></div>`;
  document.getElementById("pm-voice-cancel")?.addEventListener("click", () => {
    cancelVoice();
    showToast("Transcript discarded.", "info");
  });
  document.getElementById("pm-voice-min")?.addEventListener("click", () => foldVoice(true));
  document.getElementById("pm-voice-draft")?.addEventListener("click", async () => {
    const value = voiceTranscriptValue();
    if (!value) return showToast("Transcript is empty.", "error");
    await applyOrFallback(value, "Your words are in the chat box.");
    cleanupVoice();
  });
  document.getElementById("pm-voice-enhance")?.addEventListener("click", () => void enhanceVoiceTranscript(voiceTranscriptValue()));
  const ta = document.getElementById("pm-voice-transcript");
  ta?.addEventListener("input", () => { fitVoiceText(); renderVoiceStrip(); });
  ta?.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void enhanceVoiceTranscript(voiceTranscriptValue()); }
  });
  // A short or low window: start folded to one line rather than take it.
  foldVoice(window.innerHeight < 620 || window.innerWidth < 520, false);
  fitVoiceText();
  positionVoice();
  if (!el.classList.contains("pm-card-tucked")) requestAnimationFrame(() => ta?.focus({ preventScroll: true }));
}

function voiceTranscriptValue() {
  return document.getElementById("pm-voice-transcript")?.value.trim() || "";
}

/** The transcript box as tall as its words, up to the room there is. */
function fitVoiceText() {
  const ta = document.getElementById("pm-voice-transcript");
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight + 2, voiceTextRoom()) + "px";
}

/** Fold the review to one line, or open it again. */
function foldVoice(folded, focus = true) {
  const el = document.getElementById("pm-voice");
  if (!el || voiceState !== "reviewing") return;
  el.classList.toggle("pm-card-tucked", folded);
  renderVoiceStrip();
  positionVoice();
  if (!folded) {
    fitVoiceText();
    if (focus) document.getElementById("pm-voice-transcript")?.focus({ preventScroll: true });
  }
}

/** The one line a folded review is: what was heard, Improve, and a way back up. */
function renderVoiceStrip() {
  const strip = document.getElementById("pm-voice-strip");
  if (!strip) return;
  strip.innerHTML =
    `<span class="pm-card-strip-dot" aria-hidden="true"></span>` +
    `<span class="pm-card-strip-label">Your words</span>` +
    `<span class="pm-card-strip-gist">${escHtml(norm(voiceTranscriptValue()))}</span>` +
    `<button type="button" class="pm-card-strip-verb" data-act="improve">Improve</button>` +
    `<button type="button" class="pm-card-strip-open" data-act="open" aria-label="Show the whole transcript" data-pm-tip="Show the whole transcript">` +
    `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5 6 4.5l3 3"/></svg></button>`;
  if (!strip._pmWired) {
    strip._pmWired = true;
    strip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target.closest("[data-act='improve']")) { void enhanceVoiceTranscript(voiceTranscriptValue()); return; }
      foldVoice(false);
    });
  }
}

async function enhanceVoiceTranscript(transcript) {
  if (transcript.length < 3) {
    showToast("Transcript is too short to enhance.", "error");
    return;
  }
  if (enhanceInFlight) {
    showToast("Already enhancing — hang on a moment.", "info");
    return;
  }

  voiceState = "enhancing";
  updateVoiceOverlayState("enhancing");
  const inputMetadata = {
    inputMethod: "voice",
    inputDurationSeconds: voiceRecordingDurationSeconds,
    sourceLanguage: voiceDetectedLanguage,
  };
  hideVoiceOverlay();
  enhanceInFlight = true;
  showStreamingDiffModal(transcript);
  cardBasedOn = voiceComposerBaseline;
  cardHasBaseline = true;
  try {
    await runBackendEnhance(transcript, inputMetadata);
  } catch (error) {
    console.error("Voice enhancement error:", error);
    failStreamingModal("Could not enhance the transcript. Please try again.");
  } finally {
    enhanceInFlight = false;
    cleanupVoice({ hideOverlay: false });
  }
}

// ── Voice UI: a bar, then a card, on the chat box ──
//
// Recording took the whole page: a window over a blurred screen with a big
// timer and gradient buttons, so the conversation being answered was hidden
// while the user spoke about it. It is a slim bar on the chat box now, where
// the rewrite card sits, in the card's own look; the transcript to review
// becomes a card in the same place (showVoiceTranscriptReview).

function showVoiceOverlay() {
  // One thing on the chat box at a time: the library goes, and a rewrite card
  // folds into the pill, which keeps its draft.
  if (panelOpen) togglePanel(false);
  if (cardExpanded && cardState !== "idle") hideCard();
  let el = document.getElementById("pm-voice");
  if (!el) {
    el = document.createElement("div");
    el.id = "pm-voice";
    document.body.appendChild(el);
  }
  el.className = "pm-card pm-voice pm-voice-recording";
  el.setAttribute("role", "status");
  el.setAttribute("aria-label", "Recording");
  el.innerHTML =
    `<div class="pm-voice-bar">` +
    `<span class="pm-voice-rec" aria-hidden="true"></span>` +
    `<span class="pm-voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>` +
    `<span class="pm-voice-time" id="pm-voice-timer">0:00</span>` +
    `<span class="pm-voice-msg">Listening. You review the words before anything changes.</span>` +
    `<div class="pm-card-dock">` +
    `<button class="pm-card-act pm-card-btn" id="pm-voice-cancel" type="button" data-pm-tip="Throw the recording away" data-pm-key="Esc">Cancel</button>` +
    `<button class="pm-card-act pm-card-btn pm-card-primary" id="pm-voice-stop" type="button" data-pm-tip="Stop and transcribe">` +
    `<span class="pm-voice-stop-sq" aria-hidden="true"></span>Stop</button></div></div>`;
  document.getElementById("pm-voice-cancel").addEventListener("click", cancelVoice);
  document.getElementById("pm-voice-stop").addEventListener("click", stopVoice);
  watchVoicePlace(true);
  positionVoice();
  requestAnimationFrame(() => el.classList.add("pm-card-visible", "pm-visible"));
}

/** The recording timer's text: m:ss. */
function voiceClock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function updateVoiceOverlayState(state) {
  const el = document.getElementById("pm-voice");
  if (!el || (state !== "transcribing" && state !== "enhancing")) return;
  el.className = "pm-card pm-voice pm-voice-busy pm-card-visible pm-visible";
  el.innerHTML =
    `<div class="pm-voice-bar">` +
    `<span class="pm-voice-spin" aria-hidden="true"></span>` +
    `<span class="pm-voice-msg pm-voice-msg-strong">${state === "transcribing" ? "Turning your words into text\u2026" : "Improving your words\u2026"}</span>` +
    `<span class="pm-voice-msg">${state === "transcribing" ? "The audio is not kept." : ""}</span>` +
    `<div class="pm-card-dock"><button class="pm-card-act pm-card-btn" id="pm-voice-cancel" type="button" data-pm-key="Esc">Cancel</button></div></div>`;
  document.getElementById("pm-voice-cancel")?.addEventListener("click", cancelVoice);
  positionVoice();
}

function hideVoiceOverlay() {
  const el = document.getElementById("pm-voice");
  watchVoicePlace(false);
  if (!el) return;
  el.classList.remove("pm-card-visible", "pm-visible");
  setTimeout(() => { if (!el.classList.contains("pm-visible")) el.remove(); }, 200);
}

let voicePlaceWatch = null;
function watchVoicePlace(on) {
  if (on && !voicePlaceWatch) {
    voicePlaceWatch = () => positionVoice();
    window.addEventListener("resize", voicePlaceWatch, true);
    window.addEventListener("scroll", voicePlaceWatch, true);
  } else if (!on && voicePlaceWatch) {
    window.removeEventListener("resize", voicePlaceWatch, true);
    window.removeEventListener("scroll", voicePlaceWatch, true);
    voicePlaceWatch = null;
  }
}

/** Room for the transcript box: the space above the chat box, less the card's head and foot. */
function voiceTextRoom() {
  const el = document.getElementById("pm-voice");
  const bottom = el ? parseFloat(el.style.bottom) || 24 : 24;
  return Math.max(72, Math.min(window.innerHeight * 0.4, window.innerHeight - bottom - 12 - 150));
}

/**
 * On the chat box, as the rewrite card is: as wide as the box (capped, and
 * never narrower than 320px), its right edge on the box's, standing just
 * above it. With no chat box found, or one too near the top of the window,
 * it sits at the foot of the window.
 */
function positionVoice() {
  const el = document.getElementById("pm-voice");
  if (!el) return;
  const vw = window.innerWidth, vh = window.innerHeight, m = 12;
  const box = composerFrame(findComposer());
  // Any chat box with room above it, however narrow: at the window's foot it
  // would sit on the box.
  const onBox = box && box.top > 140;
  const width = Math.round(Math.min(600, vw - 2 * m, onBox ? Math.max(320, box.width) : 560));
  const left = onBox ? Math.max(m, Math.min(box.right - width, vw - width - m)) : Math.round((vw - width) / 2);
  const bottom = onBox ? Math.round(vh - box.top + 8) : 24;
  el.style.width = width + "px";
  el.style.left = left + "px";
  el.style.bottom = bottom + "px";
}

function updateVoiceUI(recording) {
  const btn = document.getElementById("pm-voice-btn");
  if (btn) {
    btn.classList.toggle("pm-recording", recording);
    btn.innerHTML = recording ? "⏹" : "🎤";
    btn.title = recording ? "Stop recording" : "Voice to Prompt";
  }
}

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

function truncate(str, len) {
  if (!str) return "";
  return str.length > len ? str.substring(0, len) + "..." : str;
}

function escHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function setStatus(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `pm-status${type === "success" ? " pm-status-success" : type === "error" ? " pm-status-error" : ""}`;
}

function applyTheme(theme) {
  const els = [
    document.getElementById("pm-trigger"),
    document.querySelector(".pm-modal-overlay"),
    document.getElementById("pm-voice"),
    // The card and the toast stack read the theme when they are built. Left out
    // of this list they kept whatever theme they were born with, so toggling
    // the theme with a rewrite on screen recoloured everything except the two
    // surfaces the user was actually looking at.
    document.getElementById("pm-card"),
    document.getElementById("pm-toast-stack"),
    document.getElementById("pm-library-btn"),
    document.getElementById("pm-help-btn"),
  ].filter(Boolean);
  uiTheme = theme;
  els.forEach((el) => el.setAttribute("data-pm-theme", theme));
}

// ══════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// FIRST-RUN TIPS
// ══════════════════════════════════════════════════════════════
//
// New users did not know what to do: the only trace of the extension on a
// chat page is a small ⊕ in the corner, and nothing ever said what it was or
// what came next. A tip is a short note pinned to the pill, shown at the
// moment it is useful:
//
//   meet   first visits, before any rewrite: what ⊕ does (or "set it up")
//   card   inside the first rewrite's card: Replace, and the style buttons
//   save   after the first Replace: how to keep and reuse a good prompt
//   slash  signed in, with saved prompts, never used //: type // to insert
//
// Rules: one at a time; never while the card, the library or a dialog is up;
// never takes focus; each retires when the user does the thing, dismisses
// it, or has seen it TIP_MAX_SHOWS times. All tips can be switched off in the
// popup or the library's Privacy settings. Stored locally only.

const TIP_MAX_SHOWS = 3;
const tips = { loaded: false, off: false, seen: {}, shows: {}, stats: {} };
let activeTip = null;          // { id, el }
let meetTimer = null;

function loadTips() {
  return new Promise((resolve) => {
    storageGet(["pm_tips_off", "pm_tips", "pm_tip_shows", "pm_stats"], (r) => {
      tips.off = r.pm_tips_off === true;
      tips.seen = r.pm_tips || {};
      tips.shows = r.pm_tip_shows || {};
      tips.stats = r.pm_stats || {};
      tips.loaded = true;
      resolve();
    });
  });
}

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.pm_tips_off) {
      tips.off = changes.pm_tips_off.newValue === true;
      if (tips.off) hideTip();
    }
    // "Show tips again" in the popup clears the record.
    if (changes.pm_tips) tips.seen = changes.pm_tips.newValue || {};
    if (changes.pm_tip_shows) tips.shows = changes.pm_tip_shows.newValue || {};
    if (changes.pm_stats) tips.stats = changes.pm_stats.newValue || {};
  });
} catch (error) { onOrphaned(error); }

/** Count something the user did, for the tips and the popup's "try it now". */
function statsBump(key) {
  tips.stats = { ...tips.stats, [key]: (tips.stats[key] || 0) + 1 };
  storageSet({ pm_stats: tips.stats });
}

/** The user did what a tip was for, or dismissed it: it does not come back. */
function tipDone(id) {
  if (!tips.seen[id]) {
    tips.seen = { ...tips.seen, [id]: Date.now() };
    storageSet({ pm_tips: tips.seen });
  }
  if (activeTip?.id === id) hideTip();
}

function tipAllowed(id) {
  return tips.loaded && !tips.off && !tips.seen[id] && (tips.shows[id] || 0) < TIP_MAX_SHOWS &&
    !cardExpanded && !panelOpen && !slash && !overlayHasInput() &&
    Boolean(document.getElementById("pm-trigger"));
}

const TIP_X_SVG = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg>';
// What the rewrite shortcut really is, asked of the worker (content scripts
// cannot read chrome.commands). "" when Chrome left it unassigned.
let assignedShortcut = null;
async function loadShortcut() {
  const r = await askWorker({ type: "PM_GET_SHORTCUT" });
  assignedShortcut = typeof r?.shortcut === "string" ? r.shortcut : null;
}
/** " (or <kbd>…</kbd>)", or "" when there is no shortcut to name. */
function orShortcut() {
  if (assignedShortcut === null) return ` (or <kbd>${IS_MAC ? "⌘⇧E" : "Ctrl+Shift+E"}</kbd>)`;
  return assignedShortcut ? ` (or <kbd>${escHtml(assignedShortcut)}</kbd>)` : "";
}

/**
 * Pin a tip to the pill. `actions`: [{ label, primary, run }]; running one
 * retires the tip. × and Esc retire it too: "not now" is an answer.
 */
function showTip(id, { title, body, actions = [], autoHideMs = 0, hint = false }) {
  hideTip();
  const el = document.createElement("div");
  el.id = "pm-tip";
  el.className = "pm-tip";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-live", "polite");
  el.setAttribute("aria-label", title);
  el.dataset.tip = id;
  el.innerHTML =
    `<button type="button" class="pm-tip-x" aria-label="Dismiss this tip" title="Dismiss">${TIP_X_SVG}</button>` +
    `<p class="pm-tip-title">${escHtml(title)}</p><p class="pm-tip-body">${body}</p>` +
    (actions.length
      ? `<div class="pm-tip-actions">${actions.map((a, i) =>
          `<button type="button" class="pm-tip-btn${a.primary ? " pm-tip-primary" : ""}" data-i="${i}">${escHtml(a.label)}</button>`).join("")}</div>`
      : "");
  el.querySelector(".pm-tip-x").addEventListener("click", () => tipDone(id));
  el.querySelectorAll(".pm-tip-btn").forEach((b) => b.addEventListener("click", () => {
    const action = actions[Number(b.dataset.i)];
    tipDone(id);
    action?.run?.();
  }));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); tipDone(id); }
  });
  document.body.appendChild(el);
  activeTip = { id, el, timer: autoHideMs ? setTimeout(() => { if (activeTip?.el === el) hideTip(); }, autoHideMs) : null };
  tips.shows = { ...tips.shows, [id]: (tips.shows[id] || 0) + 1 };
  storageSet({ pm_tip_shows: tips.shows });
  if (hint) document.getElementById("pm-trigger")?.classList.add("pm-pill-hint");
  positionTip();
  requestAnimationFrame(() => el.classList.add("pm-tip-visible"));
}

function hideTip() {
  if (!activeTip) return;
  clearTimeout(activeTip.timer);
  activeTip.el.remove();
  activeTip = null;
  document.getElementById("pm-trigger")?.classList.remove("pm-pill-hint");
}

/** Beside the pill: above it when there is room (it lives low on the page). */
function positionTip() {
  const el = activeTip?.el;
  const pill = document.getElementById("pm-trigger");
  if (!el || !pill) return;
  const p = pill.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight, gap = 12, m = 12;
  const above = p.top - gap - h >= m || p.top > window.innerHeight / 2;
  const top = above ? p.top - gap - h : p.bottom + gap;
  // Aligned to the pill's edge on its docked side, so the tip grows inward.
  let left = pillDock === "left" ? p.left : p.right - w;
  left = Math.max(m, Math.min(left, window.innerWidth - w - m));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(m, top))}px`;
  el.dataset.side = above ? "above" : "below";
  const arrow = Math.max(14, Math.min(w - 24, p.left + p.width / 2 - left - 5));
  el.style.setProperty("--pm-tip-arrow", `${Math.round(arrow)}px`);
}

/** Tip 1: what the ⊕ is. Shown on a chat page until the first rewrite. */
async function maybeTipMeet() {
  if (!tipAllowed("meet") || (tips.stats.rewrites || 0) > 0 || cardState !== "idle" || !findComposer()) return;
  const route = await askWorker({ type: "PM_GET_ROUTE" });
  if (!route || !tipAllowed("meet") || cardState !== "idle") return;
  const PLUS = "<b>⊕</b>";
  if (route.route === "none" || route.route === "expired") {
    showTip("meet", {
      title: "Prompt Memory is ready to set up",
      body: `It turns a rough draft into a clearer prompt when you press ${PLUS}. Choose Google or your own free key first, which takes about a minute.`,
      actions: [{ label: "Set it up", primary: true, run: () => showSetupRequiredModal() }, { label: "Not now" }],
      hint: true,
    });
    return;
  }
  const typed = norm(getCurrentInputText()).length >= 3;
  showTip("meet", typed
    ? {
        title: "Want a clearer version of this?",
        body: `Press ${PLUS}${orShortcut()}. You'll see the rewrite first; your draft only changes if you choose Replace.`,
        actions: [{ label: "Rewrite it", primary: true, run: () => handleEnhance() }, { label: "Not now" }],
        hint: true,
      }
    : {
        title: "This is Prompt Memory",
        body: `Type your prompt as usual, then press ${PLUS}${orShortcut()} for a clearer version. You review it before anything changes.` +
          (assignedShortcut === "" ? " Its keyboard shortcut is not set yet: another extension may be using it." : ""),
        actions: assignedShortcut === ""
          ? [{ label: "Got it" }, { label: "Set a shortcut", run: () => askWorker({ type: "PM_OPEN_SHORTCUTS" }) }]
          : [{ label: "Got it" }],
        hint: true,
      });
}

/** While the meet tip is up, keep its wording in step with the chat box. */
function tipsOnComposerChanged() {
  if (activeTip?.id === "meet") {
    const typed = norm(getCurrentInputText()).length >= 3;
    const says = activeTip.el.querySelector(".pm-tip-title")?.textContent || "";
    if (typed !== says.startsWith("Want")) {
      tips.shows = { ...tips.shows, meet: Math.max(0, (tips.shows.meet || 1) - 1) };   // same showing
      maybeTipMeet();
    }
  }
  if (!activeTip) maybeTipSlash();
}

/**
 * Tip 2 (inside the card): the markup, or "" once it has done its job.
 *
 * One quiet line over the buttons it explains. It was a bordered box with its
 * own ×, a box inside the card, read as one more thing to deal with before
 * the rewrite. It goes for good after the first Replace or the first style
 * tried, so it needs no × of its own.
 */
function cardTipHtml() {
  if (!tips.loaded || tips.off || tips.seen.card || cardSubject || cardShowingOriginal || cardStale) return "";
  return `<div class="pm-card-tip" id="pm-card-tip"><b>Replace draft</b> puts this in your chat box. ` +
    `Not quite right? Try another style; every version is kept.</div>`;
}

// Rewrites rated, by log id: "up" or "down". Asked on the card, where the
// rewrite is read, and not asked again in the pill after Replace.
const cardRatings = new Map();

/**
 * "Good rewrite? 👍 👎", one quiet line over the actions. The rating was only
 * asked in the pill, for six seconds after Replace; testers never saw it.
 * Only for a rewrite the server logged (there is nothing to rate against
 * otherwise), not yet rated, and never with the first-run tip, which has
 * that line.
 */
function cardRateHtml(result) {
  if (!result?.log_id || cardRatings.has(result.log_id) || cardShowingOriginal || cardStale || cardSubject) return "";
  if (cardTipHtml()) return "";
  return `<div class="pm-card-rate" id="pm-card-rate"><span>Good rewrite?</span>` +
    `<button type="button" data-rate="up" aria-label="Good rewrite" data-pm-tip="Good rewrite">${PILL_THUMB_SVG(false)}</button>` +
    `<button type="button" data-rate="down" aria-label="Not a good rewrite" data-pm-tip="Not a good rewrite">${PILL_THUMB_SVG(true)}</button></div>`;
}

/** Send the card's rating, and say thanks in its place until the card is next drawn. */
function rateCard(rating) {
  const r = cardResult;
  if (!r?.log_id || cardRatings.has(r.log_id)) return;
  cardRatings.set(r.log_id, rating);
  sendFeedback(r.log_id, rating, r.original || cardOriginal, r.enhanced).catch(() => {});
  const line = document.getElementById("pm-card-rate");
  if (line) {
    line.classList.add("pm-card-rate-done");
    line.setAttribute("role", "status");
    line.textContent = "Thanks, that helps.";
  }
}

/** Tip 3: after the first Replace, how to keep a prompt that worked. */
function maybeTipSave() {
  if ((tips.stats.inserts || 0) !== 1) return;
  setTimeout(() => {
    if (!tipAllowed("save")) return;
    if (libSignedIn) {
      showTip("save", {
        title: "Keep the prompts that work",
        body: `Press <kbd>${IS_MAC ? "⌘" : "Ctrl+"}S</kbd> on a rewrite to save it. Your saved prompts live in <b>Library</b>, beside ${"<b>⊕</b>"}.`,
        actions: [{ label: "Got it" }],
        autoHideMs: 16000,
      });
    } else {
      showTip("save", {
        title: "Keep the prompts that work",
        body: "Sign in to save good prompts and reuse them in any chat by typing <b>//</b>. Your own key keeps working either way.",
        actions: [{ label: "Sign in", primary: true, run: () => openSettings("signin") }, { label: "Not now" }],
        autoHideMs: 16000,
      });
    }
  }, 1600);
}

/** Tip 4: signed in, with saved prompts, and // never used. */
let slashTipChecked = false;
async function maybeTipSlash() {
  if (!tipAllowed("slash") || !libSignedIn || !slashEnabled || (tips.stats.slash || 0) > 0 || cardState !== "idle") return;
  if (!composerHasFocus() || norm(getCurrentInputText()).length > 40) return;
  if (!promptsLoaded) {
    if (slashTipChecked) return;
    slashTipChecked = true;
    await fetchSavedPrompts();
  }
  if (!savedPrompts.length || !tipAllowed("slash")) return;
  showTip("slash", {
    title: "Your saved prompts, one // away",
    body: "Type <b>//</b> in the chat box, then a few letters of a saved prompt, and press Enter to drop it in where you are typing.",
    actions: [{ label: "Got it" }],
    autoHideMs: 16000,
  });
}

function setupTips() {
  Promise.all([loadTips(), loadShortcut()]).then(() => {
    // A beat after the page settles, so the tip lands next to the pill in its
    // final place rather than chasing it.
    clearTimeout(meetTimer);
    meetTimer = setTimeout(maybeTipMeet, 2200);
  });
  window.addEventListener("resize", () => positionTip());
  document.addEventListener("focusin", () => { if (!activeTip) maybeTipSlash(); }, true);
}

async function init() {
  const auth = await getAuth();
  // The extension may have been reloaded while getAuth awaited storage. Do
  // not build a second UI or register listeners from this dead script.
  if (orphaned || !extensionAlive()) { onOrphaned(); return; }
  if (!auth) {
    console.log("Prompt Memory: not logged in, panel will prompt login.");
  } else if (dataConsent && tokenExpiresWithinDays(auth.token, 2) && !isTokenExpired(auth.token)) {
    tryRefreshToken(auth);
  }

  await restoreCardLayout();
  if (orphaned || !extensionAlive()) { onOrphaned(); return; }
  createTrigger();
  createLibrary();
  setupLibraryListeners();
  setupKeyboardShortcut();
  setupPassiveTracking();
  watchNavigation();
  restoreDraft();
  setupTips();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTimeout(init, 500));
} else {
  setTimeout(init, 500);
}
