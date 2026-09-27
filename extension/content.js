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

  try {
    if (hostname === "chatgpt.com") {
      document.querySelectorAll("[data-message-author-role]").forEach((el) => {
        const role = el.getAttribute("data-message-author-role");
        const text = el.innerText?.trim();
        if (text && text.length > 2) {
          messages.push(`[${role}]: ${text.substring(0, 500)}`);
        }
      });
    } else if (hostname === "claude.ai") {
      document.querySelectorAll("[class*='Message'], [data-testid*='message']").forEach((el) => {
        const text = el.innerText?.trim();
        if (text && text.length > 2) {
          const isUser = el.className?.includes("human") || el.getAttribute("data-testid")?.includes("human");
          messages.push(`[${isUser ? "user" : "assistant"}]: ${text.substring(0, 500)}`);
        }
      });
    } else if (hostname === "gemini.google.com") {
      // Gemini distinguishes the two sides in the DOM, so tag them. Emitting
      // "[message]" for both threw that information away — see below.
      document.querySelectorAll("message-content, .model-response-text, .query-text").forEach((el) => {
        const text = el.innerText?.trim();
        if (text && text.length > 2) {
          const isUser = el.classList.contains("query-text") || el.closest(".query-text");
          messages.push(`[${isUser ? "user" : "assistant"}]: ${text.substring(0, 500)}`);
        }
      });
    } else if (hostname === "grok.com" || hostname === "x.com") {
      document.querySelectorAll("[class*='message'], [class*='Message'], [data-testid*='message'], [class*='response'], [class*='query']").forEach((el) => {
        const text = el.innerText?.trim();
        if (text && text.length > 2) {
          const cls = `${el.className || ""} ${el.getAttribute("data-testid") || ""}`.toLowerCase();
          const isUser = cls.includes("query") || cls.includes("user") || cls.includes("human");
          messages.push(`[${isUser ? "user" : "assistant"}]: ${text.substring(0, 500)}`);
        }
      });
    } else {
      document.querySelectorAll("[class*='message'], [class*='Message'], [role='presentation']").forEach((el) => {
        const text = el.innerText?.trim();
        if (text && text.length > 5 && text.length < 2000) {
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
    `<span class="pm-pill-dot" aria-hidden="true"></span>` +
    `<span class="pm-pill-labelwrap"><span class="pm-pill-label"></span></span>` +
    `<button class="pm-pill-insert" type="button" hidden></button>` +
    `<span class="pm-pill-rate" hidden>` +
      `<button class="pm-pill-up" type="button" title="Good rewrite" aria-label="Good rewrite">${PILL_THUMB_SVG(false)}</button>` +
      `<button class="pm-pill-down" type="button" title="Bad rewrite" aria-label="Bad rewrite">${PILL_THUMB_SVG(true)}</button>` +
    `</span>` +
    `<button class="pm-pill-x" type="button" title="Discard this draft" aria-label="Discard draft" hidden>${PILL_X_SVG}</button>`;
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
  lib.title = `Your saved prompts (${CMD_KEY}\u21e7L)`;
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
  let libRevealTimer = null;
  const revealChip = () => {
    clearTimeout(libRevealTimer);
    if (!panelOpen) lib.classList.add("pm-lib-reveal");
  };
  const concealChip = () => {
    clearTimeout(libRevealTimer);
    libRevealTimer = setTimeout(() => lib.classList.remove("pm-lib-reveal"), 350);
  };
  for (const el of [btn, lib]) {
    el.addEventListener("pointerenter", revealChip);
    el.addEventListener("pointerleave", concealChip);
  }

  // Apply saved theme to both docked controls
  storageGet("pm_theme", (result) => {
    const theme = result.pm_theme || "dark";
    uiTheme = theme;
    btn.setAttribute("data-pm-theme", theme);
    lib.setAttribute("data-pm-theme", theme);
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
  if (cardState === "ready" && !cardStale) insertDraft();
  else if (cardState === "ready" && cardStale) redoCard();
  else if (cardState === "error") { closeCard(); handleEnhance(); }
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
function showApplied(result) {
  clearTimeout(pillApplied?.timer);
  pillApplied = { result, thanked: false, timer: setTimeout(clearApplied, 6000) };
  renderPill();
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
      verb = cardSubject ? "Update" : norm(getCurrentInputText()) ? "Replace" : "Insert";
    }
  } else if (pillApplied) {
    state = "applied";
    label = pillApplied.thanked ? "Thanks" : "Inserted";
  }

  const sig = `${state}|${label.slice(0, 60)}|${verb}|${discard}`;
  if (sig === pillSignature) return;
  pillSignature = sig;

  pill.dataset.state = state;
  pill.classList.toggle("pm-pill-open", state !== "idle");
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
    }[verb];
  }
  pill.querySelector(".pm-pill-rate").hidden = !(state === "applied" && pillApplied.result && !pillApplied.thanked);
  const xEl = pill.querySelector(".pm-pill-x");
  xEl.hidden = !discard;
  xEl.title = state === "streaming" ? "Cancel the rewrite" : state === "error" ? "Dismiss" : "Discard this draft";
  xEl.setAttribute("aria-label", xEl.title);

  pill.setAttribute("aria-label", {
    idle: "Enhance this prompt",
    streaming: "Rewriting your prompt",
    ready: "Enhanced prompt ready. Click to review or use Insert.",
    stale: "Enhanced prompt ready, but the chat box has changed since. Redo rewrites the new text.",
    error: "Enhancement failed. Retry runs it again.",
    applied: "Rewrite inserted.",
  }[state]);
  pill.title = state === "idle"
    ? "Enhance this prompt\nShift-click for your library"
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
    const w = pill.offsetWidth, h = pill.offsetHeight;
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
    const c = composer && pill.classList.contains("pm-pill-open") ? composer.getBoundingClientRect() : null;
    const cardEl = document.getElementById("pm-card");
    const cb = cardEl ? cardEl.getBoundingClientRect() : null;
    if (hits(c) || hits(cb)) {
      bottom = Math.min(maxBottom, PILL_HOME_BOTTOM);
      inset = PILL_MARGIN;
      if (hits(c)) stepAbove(c, 8);
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
      const overlaps = (left, top) => cb && left < cb.right && left + lib.offsetWidth > cb.left && top < cb.bottom && top + lib.offsetHeight > cb.top;
      const clearOfComposer = !overlaps(libLeft, libTop);

      lib.dataset.dock = pillDock;
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
    }
  }
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
    const lib = document.getElementById("pm-library-btn");
    if (lib) lib.style.opacity = "0";
    positionCard();
  });

  const end = (e) => {
    if (!start) return;
    try { pill.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    start = null;
    pill.classList.remove("pm-pill-dragging");
    const lib = document.getElementById("pm-library-btn");
    if (lib) lib.style.opacity = "";
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
    } else if (e.code === "KeyV") {
      e.preventDefault();
      toggleVoice();
    } else if (e.code === "KeyL") {
      // The library, now that the trigger button runs an enhancement instead
      // of opening the panel.
      e.preventDefault();
      togglePanel();
    }
  });
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
  more: '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>',
  clip: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.5 5.5 6 10a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4L4 8a4.2 4.2 0 0 0 6 6l3.5-3.5"/></svg>',
  back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>',
  shelf: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="4" rx="1.2"/><path d="M3.5 9.5h9M4.5 12.5h7"/></svg>',
};

// "recent" is the History tab: every rewrite, as the popup and the consent
// notice call it. "Recent" read as "recently saved", the same thing as Saved.
let libView = "saved";        // "saved" | "recent" (shown as History)
let libPage = "list";         // "list" | "privacy" | "feedback" | "signin"
let libSel = 0;               // the highlighted row
let libMenu = false;          // the ⋯ menu is open
let libRowMenu = null;        // a row whose ⋯ (Edit, Delete, …) is open
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

// ── The sheet ──

function createLibrary() {
  if (document.getElementById("pm-library")) return;
  const lib = document.createElement("div");
  lib.id = "pm-library";
  lib.className = "pm-lib";
  lib.setAttribute("role", "dialog");
  lib.setAttribute("aria-label", "Library");
  lib.hidden = true;
  document.body.appendChild(lib);

  lib.addEventListener("click", onLibraryClick);
  lib.addEventListener("input", onLibraryInput);
  lib.addEventListener("change", onLibraryChange);
  lib.addEventListener("keydown", onLibraryKeydown);
  lib.addEventListener("mousemove", (e) => {
    const row = e.target.closest?.(".pm-lib-row[data-i]");
    if (!row || Number(row.dataset.i) === libSel) return;
    libSel = Number(row.dataset.i);
    lib.querySelectorAll(".pm-lib-row[data-i]").forEach((r) => r.classList.toggle("pm-sel", Number(r.dataset.i) === libSel));
    syncActiveDescendant();
  });

  // Anywhere else closes it. Capture phase, so a host handler that stops the
  // event cannot strand the sheet open. Modals and toasts the sheet itself
  // raised (edit, delete, consent) do not count as "elsewhere".
  document.addEventListener("pointerdown", (e) => {
    if (!panelOpen) return;
    if (e.target.closest?.("#pm-library, #pm-library-btn, #pm-trigger, #pm-rail, .pm-modal-overlay, #pm-toast-stack")) return;
    togglePanel(false);
  }, true);

  storageGet(["pm_slash"], (r) => { slashEnabled = r.pm_slash !== false; });
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
  const chip = document.getElementById("pm-library-btn");
  chip?.setAttribute("aria-expanded", String(open));
  if (open) chip?.classList.remove("pm-lib-reveal");
  if (open) {
    closeSlash();
    libPage = "list";
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
  }
  // The pill folds to ⊕ while the sheet is up, and the sheet hangs off it.
  placePill();
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
  if (!libSignedIn) { libPage = "signin"; renderLibrary(); return; }
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

/** Where the sheet goes: on the pill's side, above it if there is room, else below. */
function positionLibrary() {
  const lib = document.getElementById("pm-library");
  const pill = document.getElementById("pm-trigger");
  if (!lib || lib.hidden || !pill) return;
  const p = pill.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight, m = 12, gap = 10;
  const width = Math.min(368, vw - 2 * m);
  lib.style.width = width + "px";
  const onRight = p.left + p.width / 2 > vw / 2;
  lib.style.left = onRight ? "auto" : Math.max(m, Math.min(p.left, vw - width - m)) + "px";
  lib.style.right = onRight ? Math.max(m, Math.min(vw - p.right, vw - width - m)) + "px" : "auto";
  // Opening upward, the sheet also clears the chat box when it would overlap
  // it sideways: the host's send button lives on that box's edge, and a sheet
  // resting on it is a sheet that swallows the click meant for Send.
  const left = onRight ? vw - parseFloat(lib.style.right) - width : parseFloat(lib.style.left);
  const frame = composerFrame(findComposer());
  const overlapsBox = frame && left < frame.right && left + width > frame.left && frame.top < p.top;
  const ceiling = overlapsBox ? Math.min(p.top, frame.top) : p.top;
  const above = ceiling - gap - m, below = vh - p.bottom - gap - m;
  const up = above >= 260 || above >= below;
  lib.style.top = up ? "auto" : (p.bottom + gap) + "px";
  lib.style.bottom = up ? (vh - ceiling + gap) + "px" : "auto";
  lib.style.maxHeight = Math.max(160, up ? above : below) + "px";
  lib.dataset.side = up ? "above" : "below";
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
  // What is in the chat box, offered as the first row when it is not already
  // saved. This is the whole of the old Save tab: title and tags were optional
  // there, and are one Edit away here.
  const text = norm(getCurrentInputText());
  if (!q && promptsLoaded && text.length >= 3 && !savedPrompts.some((p) => norm(p.content) === text)) {
    list.unshift({ kind: "save", text });
  }
  return list;
}

function libVerb() {
  return norm(getCurrentInputText()) ? "Replace" : "Insert";
}

function renderLibrary() {
  const lib = document.getElementById("pm-library");
  if (!lib || !panelOpen) return;
  const active = document.activeElement;
  const focusId = lib.contains(active) ? active.id : null;
  const caret = active?.id === "pm-lib-q" ? active.selectionStart : null;

  lib.dataset.page = libPage;
  lib.innerHTML = libHeadHtml() + libBodyHtml() + (libPage === "list" ? `<div class="pm-lib-foot" id="pm-lib-foot">${libFootHtml()}</div>` : "") +
    (libMenu ? libMenuHtml() : "");

  const again = focusId && lib.querySelector(`[id="${focusId}"]`);
  if (again) {
    again.focus({ preventScroll: true });
    if (caret !== null && again.setSelectionRange) again.setSelectionRange(caret, caret);
  }
  afterListRender(lib);
  positionLibrary();
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
  const more = `<button type="button" class="pm-lib-icon" id="pm-lib-more" data-act="menu" aria-label="Library menu" aria-haspopup="menu" aria-expanded="${libMenu}">${LIB_ICON.more}</button>`;
  if (libPage === "privacy" || libPage === "feedback") {
    return `<div class="pm-lib-head pm-lib-head-sub">` +
      `<button type="button" class="pm-lib-icon" id="pm-lib-back" data-act="back" aria-label="Back to the library">${LIB_ICON.back}</button>` +
      `<span class="pm-lib-head-title">${libPage === "privacy" ? "Privacy" : "Send feedback"}</span>${more}</div>`;
  }
  if (libPage === "signin") {
    return `<div class="pm-lib-head pm-lib-head-sub"><span class="pm-lib-head-title pm-lib-head-plain">Library</span>${more}</div>`;
  }
  const count = libView === "saved" ? savedPrompts.length : enhanceHistory.length;
  const placeholder = libView === "saved"
    ? (count ? `Search ${count} saved prompt${count === 1 ? "" : "s"}` : "Search saved prompts")
    : "Search your rewrite history";
  return `<div class="pm-lib-head">` +
    `<label class="pm-lib-search">${LIB_ICON.search}` +
    `<input id="pm-lib-q" type="text" autocomplete="off" spellcheck="false" placeholder="${placeholder}" value="${escHtml(searchQuery)}"` +
    ` aria-label="Search the library" role="combobox" aria-expanded="true" aria-controls="pm-lib-list" aria-autocomplete="list"></label>` +
    `<div class="pm-lib-views" role="group" aria-label="Show">` +
    `<button type="button" id="pm-lib-view-saved" data-view="saved" aria-pressed="${libView === "saved"}" title="Prompts you chose to keep">Saved</button>` +
    `<button type="button" id="pm-lib-view-recent" data-view="recent" aria-pressed="${libView === "recent"}" title="Every rewrite you have made">History</button></div>` +
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
    return `<div class="pm-lib-empty"><b>Your library is empty</b>Type a prompt in the chat box and it appears here, ready to save. ${CMD_KEY}S saves a rewrite from its card.</div>`;
  }
  const verb = libVerb();
  return list.map((it, i) => {
    const sel = i === libSel ? " pm-sel" : "";
    const id = `pm-lib-row-${i}`;
    if (it.kind === "save") {
      return `<div class="pm-lib-row pm-lib-row-save${sel}" id="${id}" data-i="${i}" role="option" aria-selected="${Boolean(sel)}">` +
        `<span class="pm-lib-dot" aria-hidden="true">+</span><div class="pm-lib-text"><div class="pm-lib-title">Save “${escHtml(it.text.slice(0, 44))}${it.text.length > 44 ? "…" : ""}”</div>` +
        `<div class="pm-lib-preview">From the chat box · rename it any time</div></div>` +
        `<div class="pm-lib-acts"><button type="button" class="pm-lib-verb" data-act="save">Save</button></div></div>`;
    }
    if (it.kind === "recent") {
      const h = it.h;
      const ago = h.timestamp ? getTimeAgo(h.timestamp) : "";
      let row = `<div class="pm-lib-row${sel}" id="${id}" data-i="${i}" role="option" aria-selected="${Boolean(sel)}">` +
        `<span class="pm-lib-dot" aria-hidden="true"></span><div class="pm-lib-text"><div class="pm-lib-title">${escHtml(norm(h.enhanced))}</div>` +
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
    let row = `<div class="pm-lib-row${sel}${att ? " pm-att" : ""}" id="${id}" data-i="${i}" role="option" aria-selected="${Boolean(sel)}">` +
      `<span class="pm-lib-dot" aria-hidden="true"></span><div class="pm-lib-text"><div class="pm-lib-title">${escHtml(promptTitle(p))}</div>` +
      `<div class="pm-lib-preview">${escHtml(promptPreview(p))}</div></div>` +
      `<div class="pm-lib-acts">` +
      `<button type="button" class="pm-lib-icon pm-lib-attach" data-act="attach" aria-pressed="${att}" aria-label="${att ? "Detach" : "Attach as context"}" title="${att ? "Attached as context" : "Attach as context"} (${CMD_KEY}↵)">${LIB_ICON.clip}</button>` +
      `<button type="button" class="pm-lib-icon" data-act="more" aria-label="More actions" aria-expanded="${libRowMenu === p.id}">${LIB_ICON.more}</button>` +
      `<button type="button" class="pm-lib-verb" data-act="insert">${verb}</button></div></div>`;
    if (libRowMenu === p.id) {
      row += `<div class="pm-lib-rowmenu"><button type="button" data-act="improve" data-i="${i}" title="Rewrite this saved prompt, then update it or save a new one">Improve</button>` +
        `<button type="button" data-act="edit" data-i="${i}">Edit</button><button type="button" class="pm-lib-danger" data-act="ask" data-i="${i}">Delete</button></div>`;
    }
    return row;
  }).join("");
}

function libFootHtml() {
  const parts = [];
  const left = usageData.limit - usageData.count;
  if (libSignedIn && usageData.known && left <= 3) {
    parts.push(`<span class="pm-lib-low">${left <= 0 ? "No rewrites left today" : left === 1 ? "1 rewrite left today" : `${left} rewrites left today`}</span>`);
  }
  if (selectedIds.size) {
    parts.push(`<span class="pm-lib-att-count">${selectedIds.size} attached as context</span>` +
      `<button type="button" class="pm-lib-link" data-act="clear">Clear</button>`);
  }
  if (!parts.length) {
    const k = (key, what) => `<span><kbd>${key}</kbd>${what}</span>`;
    parts.push(`<span class="pm-lib-hints">${k("↵", libVerb().toLowerCase())}${k(CMD_KEY + "↵", "attach")}${slashEnabled ? k("//", "in the chat box") : k("esc", "close")}</span>`);
  }
  return parts.join("");
}

function libMenuHtml() {
  const style = (s) => `<button type="button" data-style="${s}" aria-pressed="${currentMode === s}">${STYLE_NAMES[s]}</button>`;
  const left = usageData.limit - usageData.count;
  return `<div class="pm-lib-menu" role="menu" aria-label="Library menu">` +
    `<div class="pm-lib-menu-group"><div class="pm-lib-menu-cap">Rewrite style for ⊕</div>` +
    `<div class="pm-lib-views pm-lib-views-wide" role="group" aria-label="Default rewrite style">${STYLES.map(style).join("")}</div></div>` +
    `<hr>` +
    `<button type="button" class="pm-lib-mi" role="menuitem" data-act="voice">Voice input<span>${CMD_KEY}⇧V</span></button>` +
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
  closeLibrary();
  const applied = await applyOrFallback(text, null);
  if (applied) {
    showApplied(null);
    if (logId) approveEnhancement(logId);
  }
}

async function libSaveText(text) {
  const outcome = await createSavedPrompt(text, "", []);
  if (outcome === "saved") {
    statsBump("saves");
    tipDone("save");
    await fetchSavedPrompts();
    showToast("Saved to your library", "success");
  } else {
    showToast(outcome === "duplicate" ? "Already in your library" : "Could not save", outcome === "duplicate" ? "info" : "error");
  }
  renderLibrary();
}

function libAct(act, i) {
  const list = libraryItems();
  const it = list[i ?? libSel];
  switch (act) {
    case "insert":
      if (!it) return;
      if (it.kind === "save") { libSaveText(it.text); return; }
      if (it.kind === "recent") { libInsert(it.h.enhanced, it.h.log_id); return; }
      libInsert(it.p.content);
      return;
    case "save":
      if (it?.kind === "save") libSaveText(it.text);
      return;
    case "attach":
      if (it?.kind === "saved") toggleAttachment(it.p);
      return;
    case "more":
      if (!it || it.kind === "save") return;
      libRowMenu = it.kind === "recent" ? (libRowMenu === "r" + (i ?? libSel) ? null : "r" + (i ?? libSel)) : (libRowMenu === it.p.id ? null : it.p.id);
      libSel = i ?? libSel;
      renderLibraryList();
      return;
    case "edit":
      if (it?.kind === "saved") { libRowMenu = null; showEditModal(it.p); }
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
      if (it?.kind === "recent") { libRowMenu = null; libSaveText(it.h.enhanced); }
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
  if (b?.dataset.view) {
    libView = b.dataset.view;
    libSel = 0; libRowMenu = null; libConfirm = null;
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
    case "back": libPage = "list"; libMenu = false; renderLibrary(); focusLibrarySearch(); return;
    case "privacy": libPage = "privacy"; libMenu = false; renderLibrary(); return;
    case "feedback":
      libPage = "feedback"; libMenu = false; renderLibrary();
      storageGet(["email"], (r) => { const el = document.getElementById("pm-feedback-email"); if (el && !el.value) el.value = r.email || ""; });
      loadRecentFeedback();
      return;
    case "voice": closeLibrary(); toggleVoice(); return;
    case "signin": openSettings(); return;
    case "clear": clearAttachments(); return;
    case "sendfeedback": sendLibraryFeedback(); return;
  }
  const rowEl = e.target.closest("[data-i]");
  const i = rowEl ? Number(rowEl.dataset.i) : undefined;
  if (act) { libAct(act, i); return; }
  // A click on the row itself does the row's verb.
  if (rowEl?.classList.contains("pm-lib-row")) { libSel = i; libAct("insert", i); }
}

function onLibraryInput(e) {
  if (e.target.id !== "pm-lib-q") return;
  searchQuery = e.target.value;
  libSel = 0; libRowMenu = null; libConfirm = null;
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
    if (libPage === "privacy" || libPage === "feedback") { libPage = "list"; renderLibrary(); focusLibrarySearch(); return; }
    closeLibrary();
    return;
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
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault(); e.stopPropagation();
    if (!n) return;
    libAct(mod ? "attach" : "insert");
  }
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
  if (!el) return null;
  const inner = el.getBoundingClientRect();
  let frame = inner;
  let node = el.parentElement;
  for (let i = 0; node && i < 6; i++, node = node.parentElement) {
    const r = node.getBoundingClientRect();
    if (r.width > inner.width + 240 || r.height > inner.height + 200) break;
    const cs = getComputedStyle(node);
    const drawn = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderRadius) >= 8 ||
      (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent");
    if (drawn) frame = r;
  }
  return frame;
}

/**
 * The rail: attached prompts as chips on the chat box's top edge.
 *
 * It names them on the thing about to be sent, rather than counting them in a
 * panel the user has closed. It steps aside while the rewrite card is open,
 * because the card sits on that same edge, and when the chat box is too near
 * the top of the window to leave room above it.
 */
function renderRail() {
  let rail = document.getElementById("pm-rail");
  if (!selectedIds.size) { rail?.remove(); return; }
  if (!rail) {
    rail = document.createElement("div");
    rail.id = "pm-rail";
    rail.className = "pm-rail";
    rail.setAttribute("role", "group");
    rail.setAttribute("aria-label", "Attached as context for the next rewrite");
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
  rail.innerHTML = [...selectedIds].map((id) => {
    const title = attachTitles.get(id) || "Saved prompt";
    return `<span class="pm-rail-chip" title="Attached as context: ${escHtml(title)}">${LIB_ICON.clip}<span>${escHtml(title)}</span>` +
      `<button type="button" data-detach="${escHtml(String(id))}" aria-label="Detach ${escHtml(title)}">${PILL_X_SVG}</button></span>`;
  }).join("") + `<button type="button" class="pm-rail-add" data-act="railadd" aria-label="Attach another saved prompt">+ Context</button>`;
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
  rail.style.bottom = Math.round(window.innerHeight - r.top + 6) + "px";
  rail.style.maxWidth = Math.max(180, Math.round(r.width)) + "px";
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
  return savedPrompts
    .filter((p) => !q || [p.title, p.content, ...(p.tags || [])].join(" ").toLowerCase().includes(q.replace(/^#/, "")))
    .slice(0, 6);
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
  const head = `<div class="pm-caret-head"><b>//${escHtml(slash.q)}</b><span>↵ insert · ⇥ attach · esc</span></div>`;
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
    if (!items.length) { closeSlash(); return; }
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

/** The chat box's text changed. Batched: one keystroke can be many mutations. */
function onComposerChanged() {
  if (composerChangeQueued) return;
  composerChangeQueued = true;
  Promise.resolve().then(() => {
    composerChangeQueued = false;
    checkSlash();
    refreshCardStaleness();
    positionRail();
    tipsOnComposerChanged();
  });
}

function setupLibraryListeners() {
  window.addEventListener("keydown", handleSlashKeydown, true);
  document.addEventListener("input", (e) => {
    const composer = findComposer();
    if (composer && (e.target === composer || composer.contains(e.target))) {
      checkSlash();
      requestAnimationFrame(positionRail);
      // A <textarea> composer changes its value, not its DOM, so the
      // MutationObserver never fires for it: the tips hear typing here too.
      tipsOnComposerChanged();
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
  window.addEventListener("scroll", () => { positionRail(); if (slash) renderSlash(); }, true);
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
    const selection = card.querySelector("#pm-card-toggle");
    const selectionLabel = `${wide ? "Select" : "Show"} ${cardShowingOriginal ? "rewrite" : "original"}`;
    if (selection && selection.textContent !== selectionLabel) selection.textContent = selectionLabel;
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
  const selection = card.querySelector("#pm-card-toggle");
  const selectionLabel = `Show ${cardShowingOriginal ? "rewrite" : "original"}`;
  if (selection && selection.textContent !== selectionLabel) selection.textContent = selectionLabel;
  card.style.height = "";

  // A sheet on the composer: as wide as the box (capped), right-aligned to
  // it, so it reads as a suggestion growing out of the box it will land in.
  // The first cut hung the card off the pill and then pushed it up to clear
  // the composer, which left it 450px from the pill and aligned to nothing.
  // With no composer on the page it hangs off the pill instead.
  const box = composer ? composer.getBoundingClientRect() : null;
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
  if (useAbove) {
    // The card's bottom edge: just above whatever it sits on, and never over
    // the composer.
    let floor = (onComposer ? box.top : pillBox.top) - gap;
    if (overlapsComposer && box.top - gap < floor) floor = box.top - gap;
    room = floor - margin;
    // Give the rewrite whatever is left over, rather than letting the card grow
    // past the space it has. Clamping the card's TOP against the viewport
    // instead would walk it down over the composer exactly when the head made
    // it taller. MIN_TEXT stops a short window collapsing the rewrite to a
    // sliver.
    card.style.setProperty("--pm-card-text-max", Math.max(MIN_TEXT, room - frame) + "px");
    top = Math.max(margin, floor - (card.offsetHeight || 160));
  } else {
    let ceiling = pillBox.bottom + gap;
    let floor = window.innerHeight - margin;
    if (overlapsComposer && box.top > ceiling) floor = box.top - gap;
    room = floor - ceiling;
    card.style.setProperty("--pm-card-text-max", Math.max(MIN_TEXT, room - frame) + "px");
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
  card.innerHTML = innerHTML +
    `<button type="button" class="pm-card-resize" id="pm-card-resize" aria-label="Card size and position" aria-expanded="false" aria-controls="pm-card-layout" title="Drag to resize, or click to move and size with buttons"></button>`;
  cardExpanded = true;
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
  cardMinimized = true;
  // Folding the card leaves the pill as it was, so placement is not re-run on
  // its own; the rail has to be told the edge is free again.
  positionRail();
  draftStore.setExpanded(false);
  renderPill();
}

/** Show the card again for a draft the pill is holding. */
function expandCard() {
  cardMinimized = false;
  draftStore.setExpanded(true);
  if (cardState === "ready" && cardResult) showDiffModal(cardResult);
  else if (cardState === "error") failStreamingModal(cardError);
  else if (cardState === "streaming") showStreamingCardAgain();
}

function toggleCard() {
  if (cardExpanded) hideCard();
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

function cardFoot(parts) {
  return `<div class="pm-card-foot">${parts.join("")}</div>`;
}

const cardKey = (k) => `<span class="pm-card-key">${k}</span>`;

/**
 * The card's title bar: what this card is, and the one window control it has.
 *
 * Minimize, not close. The draft is never lost from here — it folds down into
 * the pill and comes back with a click (or ⌘⇧P). Discard is a footer action,
 * deliberately further from the corner the hand goes to when it wants a
 * window out of the way. The bar also carries the stale and error notices, so
 * the card has the same anatomy in every state: head, text, foot.
 */
function cardHead(title, kind = "") {
  return `<div class="pm-card-head${kind ? " pm-card-head-" + kind : ""}" title="Drag to move">` +
    `<span class="pm-card-head-dot" aria-hidden="true"></span>` +
    `<span class="pm-card-title">${title}</span>` +
    `<button class="pm-card-reset" type="button" id="pm-card-reset" title="Return beside the prompt" aria-label="Return card beside the prompt">↙</button>` +
    `<button class="pm-card-min" type="button" id="pm-card-min" title="Minimize to the pill (esc)" aria-label="Minimize to the pill">${CARD_MIN_SVG}</button>` +
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
      `<button class="pm-card-act" id="pm-card-cancel">${cardKey("esc")} cancel</button>`,
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
      `<button class="pm-card-act pm-card-primary" id="pm-card-retry">${cardKey(CMD_KEY + "\u21B5")} try again</button>`,
      `<button class="pm-card-act" id="pm-card-dismiss">${cardKey("esc")} dismiss</button>`,
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
  const head = cardStale
    ? cardHead(cardShowingOriginal
        ? "Prompt changed \u2014 this is the text the rewrite was built from"
        : "Prompt changed \u2014 this rewrite is for the earlier text", "stale")
    : cardHead(cardShowingOriginal
        ? (cardSubject ? "Saved prompt, as it is" : "Original")
        : `${cardSubject ? `Improved \u201c${escHtml(clipText(cardSubject.title, 32))}\u201d` : "Rewrite"}${STYLE_NAMES[result.mode] ? " \u00b7 " + STYLE_NAMES[result.mode] : ""}`);

  // Which saved prompts shaped this rewrite, each one named, with a way to
  // drop an auto-matched one and rewrite again without it. Only shown when a
  // saved prompt actually took part.
  const chip = cardUsedHtml(result);

  const truncatedNote = result.truncated
    ? `<span class="pm-card-meta" style="color:var(--pm-danger)">cut short</span>`
    : `<span class="pm-card-meta">${result.latency ? result.latency + "s" : ""}</span>`;

  // One footer, with accept swapped for its disabled twin. The stale variant
  // used to be a separate, shorter list, which silently dropped \ original and
  // ⌘S save while their key handlers below stayed live. A footer that stops
  // listing keys that still work is worse than one that never listed them, and
  // the reflow made the card visibly rebuild itself the moment you typed.
  const acceptLabel = cardSubject
    ? (cardShowingOriginal ? "Keep it as it is" : "Update saved prompt")
    : cardShowingOriginal ? "Use original" : norm(getCurrentInputText()) ? "Replace draft" : "Insert";
  const accept = cardStale
    ? `<span class="pm-card-act pm-card-disabled" title="The prompt changed — redo first">${acceptLabel}</span>`
    : `<button class="pm-card-act pm-card-primary" id="pm-card-accept">${acceptLabel}</button>`;

  const actions = [
    accept,
    ...(cardStale
      ? [`<button class="pm-card-act pm-card-redo" id="pm-card-redo">${cardKey(CMD_KEY + "\u21B5")} redo</button>`]
      : []),
    // Hide, not dismiss: the draft goes back into the pill and can be brought
    // up again — from this chat or the next one. Discard is its own action.
    `<button class="pm-card-act" id="pm-card-close">${cardKey("esc")} minimize</button>`,
    `<button class="pm-card-act" id="pm-card-toggle">${cardShowingOriginal ? "Show rewrite" : "Show original"}</button>`,
    `<button class="pm-card-act" id="pm-card-save">${cardKey(CMD_KEY + "S")} ${cardSubject ? "save as new" : "save"}</button>`,
    `<button class="pm-card-act pm-card-discard" id="pm-card-discard">discard</button>`,
    `<span class="pm-card-spacer"></span>`,
    truncatedNote,
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
  const card = openCard(head + body + cardTipHtml() + chip + cardStyleRow(result) + cardFoot(actions));
  card.classList.toggle("pm-card-stale", cardStale);

  const textEl = card.querySelector(".pm-card-text");
  if (textEl && prevScroll && textEl.textContent === prevContent) {
    textEl.scrollTop = prevScroll;
  }
  watchScrollable(textEl);
  markScrollable(textEl);

  document.getElementById("pm-card-accept")?.addEventListener("click", acceptCard);
  document.getElementById("pm-card-close")?.addEventListener("click", hideCard);
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
  document.getElementById("pm-card-ver-prev")?.addEventListener("click", () => stepVersion(-1));
  document.getElementById("pm-card-ver-next")?.addEventListener("click", () => stepVersion(1));
  document.getElementById("pm-card-tip-x")?.addEventListener("click", () => {
    tipDone("card");
    document.getElementById("pm-card-tip")?.remove();
    positionCard();
  });
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
 */
function cardUsedHtml(result) {
  if (cardShowingOriginal) return "";
  const d = result.context_details || {};
  const items = [
    ...(d.selected_prompts || []).map((p) => ({ ...p, kind: "attached" })),
    ...(d.auto_matched_prompts || []).map((p) => ({ ...p, kind: "matched" })),
  ];
  const left = result.excluded || [];
  if (!items.length && !left.length) {
    // A server that sends counts only.
    const n = (result.context_used?.auto_matched || 0) + (result.context_used?.selected || 0);
    return n ? `<div class="pm-card-chip">\u21B3 ${n} saved prompt${n > 1 ? "s" : ""} used</div>` : "";
  }
  const flat = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + "\u2026" : t);
  const name = (p) => flat(p.title) || clip(flat(p.content), 40) || "Saved prompt";
  const summary = items.length
    ? "Used " + items.slice(0, 2).map((p) => escHtml(clip(name(p), 26))).join(" \u00b7 ") +
      (items.length > 2 ? ` +${items.length - 2}` : "")
    : "No saved prompts used";
  const rows = items.map((p) => {
    const why = p.kind === "attached" ? "you attached it" : Number(p.score) >= 0.5 ? "close match" : "loose match";
    const preview = p.title && p.content ? " \u00b7 " + escHtml(clip(flat(p.content), 80)) : "";
    const drop = p.kind === "matched" && p.id && !cardStale
      ? `<button type="button" class="pm-card-used-drop" data-pm-drop="${escHtml(p.id)}" data-pm-title="${escHtml(name(p))}" ` +
        `title="Rewrite again without this saved prompt">Don\u2019t use</button>`
      : "";
    return `<li class="pm-card-used-item pm-card-used-${p.kind}">` +
      `<span class="pm-card-used-icon" aria-hidden="true">${p.kind === "attached" ? LIB_ICON.clip : "\u2248"}</span>` +
      `<span class="pm-card-used-text"><span class="pm-card-used-name">${escHtml(clip(name(p), 60))}</span>` +
      `<span class="pm-card-used-why">${why}${preview}</span></span>${drop}</li>`;
  }).join("");
  const leftOut = left.length
    ? `<li class="pm-card-used-left">Left out: ${left.map((x) => escHtml(clip(flat(x.title) || "a saved prompt", 40))).join(", ")}</li>`
    : "";
  return `<div class="pm-card-used">` +
    `<button type="button" class="pm-card-chip pm-card-used-toggle" id="pm-card-used-toggle" aria-expanded="${cardUsedOpen}" ` +
    `aria-controls="pm-card-used-list" title="The saved prompts this rewrite drew on">\u21B3 ${summary}` +
    `<span class="pm-card-used-caret" aria-hidden="true">\u25BE</span></button>` +
    `<ul class="pm-card-used-list" id="pm-card-used-list"${cardUsedOpen ? "" : " hidden"}>${rows}${leftOut}</ul></div>`;
}

/**
 * The other two styles, and a way back through the versions already made.
 *
 * Hidden while the original is showing (there is no rewrite to vary) and while
 * the draft is stale (Redo is the only honest action then). A style already
 * made is shown rather than re-requested: switching back to it is free, and
 * spending one of fifteen daily rewrites on text you have already seen is the
 * thing this row must never do.
 */
function cardStyleRow(result) {
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
      `${spent ? ' aria-disabled="true"' : ""} title="${escHtml(title)}">${STYLE_VERBS[on][s]}${note}</button>`;
  }).join("");
  const n = cardVersions.length;
  const versions = n > 1
    ? `<span class="pm-card-versions" role="group" aria-label="Versions">` +
      `<button type="button" class="pm-card-ver" id="pm-card-ver-prev" aria-label="Previous version" title="Previous version ([)"${cardVersionIndex === 0 ? " disabled" : ""}>\u2039</button>` +
      `<span aria-live="polite">${cardVersionIndex + 1} of ${n}</span>` +
      `<button type="button" class="pm-card-ver" id="pm-card-ver-next" aria-label="Next version" title="Next version (])"${cardVersionIndex === n - 1 ? " disabled" : ""}>\u203a</button>` +
      `</span>`
    : "";
  return `<div class="pm-card-styles">${versions}<span class="pm-card-styles-try" role="group" aria-label="Other styles">${styles}</span></div>`;
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
  closeCard();

  // One event, one toast. The feedback toast carries the confirmation itself,
  // so applyOrFallback is told to stay quiet on success — but only when there
  // is actually something to rate. Without a log_id the rating cannot be sent
  // anywhere, and asking anyway spends the user's attention on nothing.
  const canRate = Boolean(result.log_id);
  const applied = await applyOrFallback(text, null);
  // The pill says "Inserted" and, when there is a log_id to rate against,
  // asks how it was — in the object the user was already looking at, rather
  // than a toast beside a pill that had just collapsed.
  if (applied) showApplied(canRate ? result : null);
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

async function saveCard() {
  if (!cardResult) return;
  if (cardSubject) {
    const outcome = await createSavedPrompt(cardResult.enhanced, `${cardSubject.title} (improved)`, []);
    if (outcome === "saved") fetchSavedPrompts();
    showToast(outcome === "saved" ? "Saved as a new prompt; the original is unchanged" : outcome === "duplicate" ? "Already in your library" : "Could not save",
      outcome === "saved" ? "success" : outcome === "duplicate" ? "info" : "error");
    return;
  }
  const outcome = await createSavedPrompt(cardResult.enhanced, null, []);
  if (outcome === "duplicate") {
    showToast("Already in your library", "info");
    return;
  }
  const saved = outcome === "saved";
  showToast(saved ? "Saved to your library" : "Could not save", saved ? "success" : "error");
  if (saved) { fetchSavedPrompts(); statsBump("saves"); tipDone("save"); }
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
    document.querySelector(".pm-modal-overlay.pm-visible, .pm-voice-overlay.pm-visible")
  );
}

// Tab is always navigation. Other shortcuts only apply while focus belongs
// to the composer, pill, or card; ordinary typing never invokes card actions.
function handleCardKeydown(e) {
  if (e.key === "Tab" || e.isComposing || e.defaultPrevented) return;
  if (e.key === "Escape" && document.querySelector(".pm-voice-overlay.pm-visible")) {
    e.preventDefault(); e.stopPropagation(); cancelVoice(); return;
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
    if (card) hideCard(); else expandCard();
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
  // Save/redo belong to the review controls, not the host's editor.
  if (!inCard || cardState !== "ready") return;
  if ((e.key === "[" || e.key === "]") && !e.metaKey && !e.ctrlKey && !e.altKey && cardVersions.length > 1) {
    e.preventDefault(); e.stopPropagation(); stepVersion(e.key === "]" ? 1 : -1); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault(); e.stopPropagation(); redoCard(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault(); e.stopPropagation(); saveCard();
  }
}
document.addEventListener("keydown", handleCardKeydown, true);

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

  const gap = 10;
  const margin = 12;

  // The HIGHEST of the two, not just the card. On the empty-chat layout the
  // card renders BELOW the composer, so anchoring to the card alone would drop
  // the toast straight onto the composer.
  const tops = [document.getElementById("pm-card"), findComposer()]
    .filter(Boolean)
    .map((el) => el.getBoundingClientRect().top);

  const height = stack.offsetHeight || 44;
  const top = tops.length
    ? Math.min(...tops) - gap - height
    : window.innerHeight - 80 - height;

  stack.style.top = Math.max(margin, top) + "px";
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
// EDIT MODAL
// ══════════════════════════════════════════════════════════════

function showEditModal(prompt) {
  const overlay = getOrCreateModalOverlay();
  const modal = overlay.querySelector(".pm-modal");

  modal.innerHTML = `
    <div class="pm-modal-header">
      <span class="pm-modal-title">Edit Prompt</span>
      <button class="pm-header-close pm-modal-close-btn">×</button>
    </div>
    <div class="pm-modal-body">
      <label class="pm-label">Content</label>
      <textarea class="pm-edit-textarea" id="pm-edit-content">${escHtml(prompt.content)}</textarea>
      <label class="pm-label">Title <span style="color:var(--pm-text-muted)">(optional)</span></label>
      <input class="pm-edit-input" id="pm-edit-title" value="${escHtml(prompt.title || "")}" placeholder="Optional title" />
      <label class="pm-label">Tags <span style="color:var(--pm-text-muted)">(optional, comma-separated)</span></label>
      <input class="pm-edit-input" id="pm-edit-tags" value="${escHtml((prompt.tags || []).join(", "))}" placeholder="e.g. coding, review" />
    </div>
    <div class="pm-modal-footer">
      <button class="pm-btn pm-btn-secondary pm-modal-close-btn">Cancel</button>
      <button class="pm-btn pm-btn-primary" id="pm-edit-save">Save Changes</button>
    </div>
  `;

  overlay.querySelectorAll(".pm-modal-close-btn").forEach((b) =>
    b.addEventListener("click", closeModal)
  );

  document.getElementById("pm-edit-save").addEventListener("click", async () => {
    const content = document.getElementById("pm-edit-content").value.trim();
    const title = document.getElementById("pm-edit-title").value.trim();
    const tagsRaw = document.getElementById("pm-edit-tags").value.trim();
    const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter((t) => t) : [];
    if (!content) return;

    const fields = {};
    if (content !== prompt.content) fields.content = content;
    if (title !== (prompt.title || "")) fields.title = title || null;
    if (JSON.stringify(tags) !== JSON.stringify(prompt.tags || [])) fields.tags = tags;

    if (Object.keys(fields).length === 0) { closeModal(); return; }

    const btn = document.getElementById("pm-edit-save");
    btn.disabled = true;
    btn.textContent = "Saving...";

    const ok = await updateSavedPrompt(prompt.id, fields);
    if (ok) {
      await fetchSavedPrompts();
      renderLibrary();
    }
    closeModal();
  });

  overlay.classList.add("pm-visible");
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

// Ordered most- to least-specific. querySelector returns the FIRST match in
// document order, which on several of these sites is a hidden search box or an
// off-screen editor, so visibility is checked before a candidate is accepted.
const COMPOSER_SELECTORS = [
  "#prompt-textarea",                          // ChatGPT
  "div[contenteditable='true'][role='textbox']",
  "[data-testid='chat-input'] [contenteditable='true']",
  "form [contenteditable='true']",
  "form textarea",
  "[contenteditable='true']",
  "textarea",
];

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
    const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const secs = String(elapsed % 60).padStart(2, "0");
    const timerEl = document.getElementById("pm-voice-timer");
    if (timerEl) timerEl.textContent = `${mins}:${secs}`;
  }, 1000);
  voiceStopTimer = setTimeout(() => {
    if (voiceState !== "recording") return;
    showToast(`Recording limit reached (${VOICE_MAX_RECORDING_SECONDS}s). Preparing your transcript…`, "info");
    stopVoice();
  }, VOICE_MAX_RECORDING_SECONDS * 1000);

  showToast("🎤 Recording… you will review the transcript before enhancement.", "info");
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
    showVoiceTranscriptReview(data.transcription || "", data.transcription_time);
  } catch (error) {
    if (error?.name === "AbortError") return;
    cleanupVoice();
    console.error("Voice transcription error:", error);
    showToast(error?.message || "Voice transcription failed. Check your connection.", "error");
  } finally {
    voiceAbortController = null;
  }
}

function showVoiceTranscriptReview(transcript, transcriptionTime) {
  if (!transcript.trim()) {
    cleanupVoice();
    showToast("Could not understand the recording. Please try again.", "error");
    return;
  }

  voiceState = "reviewing";
  const overlay = document.getElementById("pm-voice-overlay");
  if (!overlay) return;
  const language = voiceDetectedLanguage === "unknown" ? "Language auto-detected" : `Language: ${voiceDetectedLanguage}`;
  overlay.innerHTML = `
    <div class="pm-voice-card pm-voice-review-card" role="dialog" aria-modal="true" aria-label="Review voice transcript">
      <div class="pm-voice-indicator"><span class="pm-voice-label">Review transcript</span></div>
      <p class="pm-voice-hint">${escHtml(language)} · transcribed in ${Number(transcriptionTime || 0).toFixed(2)}s. Edit anything before it is enhanced.</p>
      <label class="pm-voice-transcript-label" for="pm-voice-transcript">Transcript</label>
      <textarea id="pm-voice-transcript" class="pm-voice-transcript" rows="7" spellcheck="true">${escHtml(transcript)}</textarea>
      <div class="pm-voice-actions">
        <button class="pm-btn pm-btn-secondary" id="pm-voice-draft" type="button">Use as draft</button>
        <button class="pm-btn pm-btn-secondary" id="pm-voice-cancel" type="button">Discard</button>
        <button class="pm-btn pm-btn-primary" id="pm-voice-enhance" type="button">Enhance transcript</button>
      </div>
    </div>
  `;
  document.getElementById("pm-voice-cancel")?.addEventListener("click", cancelVoice);
  document.getElementById("pm-voice-draft")?.addEventListener("click", async () => {
    const value = document.getElementById("pm-voice-transcript")?.value.trim() || "";
    if (!value) return showToast("Transcript is empty.", "error");
    await applyOrFallback(value, "Transcript added to the chat input.");
    cleanupVoice();
  });
  document.getElementById("pm-voice-enhance")?.addEventListener("click", () => {
    const value = document.getElementById("pm-voice-transcript")?.value.trim() || "";
    void enhanceVoiceTranscript(value);
  });
  requestAnimationFrame(() => document.getElementById("pm-voice-transcript")?.focus());
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

// ── Voice UI: Recording Overlay ──

function showVoiceOverlay() {
  let overlay = document.getElementById("pm-voice-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "pm-voice-overlay";
    overlay.className = "pm-voice-overlay";
    // The voice screen is also created on demand, so it must inherit the
    // panel's active theme instead of resolving its variables from :root.
    overlay.setAttribute(
      "data-pm-theme",
      uiTheme
    );
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `
    <div class="pm-voice-card">
      <div class="pm-voice-indicator">
        <div class="pm-voice-bars">
          <span class="pm-bar"></span><span class="pm-bar"></span><span class="pm-bar"></span>
          <span class="pm-bar"></span><span class="pm-bar"></span>
        </div>
        <span class="pm-voice-label">Recording</span>
      </div>
      <div class="pm-voice-timer" id="pm-voice-timer">00:00</div>
      <div class="pm-voice-hint">Speak naturally. You will review the transcript before anything is enhanced.</div>
      <div class="pm-voice-actions">
        <button class="pm-btn pm-btn-secondary" id="pm-voice-cancel" type="button">Cancel</button>
        <button class="pm-btn pm-btn-primary pm-voice-stop" id="pm-voice-stop" type="button">Stop recording</button>
      </div>
    </div>
  `;

  overlay.addEventListener("click", (e) => { if (e.target === overlay) cancelVoice(); });
  document.getElementById("pm-voice-cancel").addEventListener("click", cancelVoice);
  document.getElementById("pm-voice-stop").addEventListener("click", stopVoice);

  requestAnimationFrame(() => overlay.classList.add("pm-visible"));
}

function updateVoiceOverlayState(state) {
  const card = document.querySelector(".pm-voice-card");
  if (!card) return;

  if (state === "transcribing" || state === "enhancing") {
    const label = state === "transcribing" ? "Transcribing recording…" : "Enhancing transcript…";
    const hint = state === "transcribing"
      ? "Whisper is processing your audio. Audio is not saved by Prompt Memory."
      : "Building your improved prompt…";
    card.innerHTML = `
      <div class="pm-voice-indicator">
        <div class="pm-voice-spinner"></div>
        <span class="pm-voice-label">${label}</span>
      </div>
      <div class="pm-voice-hint">${hint}</div>
      <button class="pm-btn pm-btn-secondary" id="pm-voice-cancel" type="button">Cancel</button>
    `;
    document.getElementById("pm-voice-cancel")?.addEventListener("click", cancelVoice);
  }
}

function hideVoiceOverlay() {
  const overlay = document.getElementById("pm-voice-overlay");
  if (overlay) {
    overlay.classList.remove("pm-visible");
    setTimeout(() => {
      if (!overlay.classList.contains("pm-visible")) overlay.remove();
    }, 300);
  }
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
    document.querySelector(".pm-voice-overlay"),
    // The card and the toast stack read the theme when they are built. Left out
    // of this list they kept whatever theme they were born with, so toggling
    // the theme with a rewrite on screen recoloured everything except the two
    // surfaces the user was actually looking at.
    document.getElementById("pm-card"),
    document.getElementById("pm-toast-stack"),
    document.getElementById("pm-library-btn"),
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

/** Tip 2 (inside the card): the markup, or "" once it has done its job. */
function cardTipHtml() {
  if (!tips.loaded || tips.off || tips.seen.card || cardSubject || cardShowingOriginal || cardStale) return "";
  return `<div class="pm-card-tip" id="pm-card-tip"><span><b>Replace draft</b> puts this in your chat box. Not quite right? ` +
    `The buttons below make another version, and every version is kept.</span>` +
    `<button type="button" id="pm-card-tip-x" aria-label="Dismiss this tip" title="Dismiss">${TIP_X_SVG}</button></div>`;
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
