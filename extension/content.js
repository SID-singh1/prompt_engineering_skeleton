// extension/content.js — Prompt Memory v4
// One-click prompt engineering. Conversation-aware. Mode-aware. Platform-aware.
// Streaming enhancement. History. Token auto-refresh. Multi-language voice.

// Default API URL — overridden by chrome.storage.local['api_url'] (set via popup)
const DEFAULT_API_URL = "https://siddhm11-prompt-engine.hf.space";  // ← production
// const DEFAULT_API_URL = "http://localhost:8000";  // ← local testing
let API_URL = DEFAULT_API_URL;

// Load configured API URL from storage on startup
chrome.storage.local.get("api_url", (result) => {
  if (result.api_url) API_URL = result.api_url;
});

// Listen for URL changes from popup
chrome.storage.onChanged.addListener((changes) => {
  if (changes.api_url) API_URL = changes.api_url.newValue || DEFAULT_API_URL;
});

console.log("Prompt Memory v4: loaded on", window.location.hostname);

// ══════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════

let savedPrompts = [];
let selectedIds = new Set();
let panelOpen = false;
let currentTab = "context"; // "context" | "save" | "history" | "feedback"
let currentMode = "deep";   // "quick" | "deep" | "creative"
let lastEnhanceResult = null;
let searchQuery = "";
let isRecording = false;
let voiceState = "idle"; // idle | recording | stopping | transcribing | reviewing | enhancing
let enhanceHistory = [];
let usageData = { count: 0, limit: 30 };
let isLoadingTab = false;
// Passive prompt tracking: records every prompt the user submits on these
// sites, whether or not they ever press Enhance, and keeps it server-side.
//
// This defaulted to ON with no disclosure anywhere in the product. Chrome Web
// Store's Limited Use disclosure requirements have been enforceable since
// 1 Aug 2026 and require prominent disclosure plus affirmative consent before
// collecting this kind of data — silent opt-out collection is a rejection at
// review, and a trust problem well before that for anyone drafting client work.
//
// Opt-in now. Nothing is collected until the user turns it on themselves.
let promptTrackingEnabled = false;

// Conversation context is different in kind: it is read from the page only
// while fulfilling an enhancement the user explicitly asked for, is sent for
// that one request, and is not retained as a profile. It stays on by default
// and is disclosed and toggleable in the panel.
let contextEnabled = true;

// Load privacy preferences
chrome.storage.local.get(["pm_tracking", "pm_context"], (result) => {
  promptTrackingEnabled = result.pm_tracking === true;   // default: OFF
  contextEnabled = result.pm_context !== false;          // default: on
});

// ══════════════════════════════════════════════════════════════
// AUTH HELPERS (with auto-refresh)
// ══════════════════════════════════════════════════════════════

function getAuth() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["user_id", "token", "email"], (result) => {
      resolve(result.token ? result : null);
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
      chrome.storage.local.set({ token: data.token, email: data.email, user_id: data.user_id });
      console.log("Prompt Memory: token auto-refreshed");
      return data.token;
    }
  } catch (e) {
    console.log("Prompt Memory: token refresh failed", e);
  }
  return null;
}

async function authedFetch(url, options = {}) {
  const auth = await getAuth();
  if (!auth) return null;

  // Auto-refresh if token expires within 2 days
  let token = auth.token;
  if (tokenExpiresWithinDays(token, 2) && !isTokenExpired(token)) {
    const newToken = await tryRefreshToken(auth);
    if (newToken) token = newToken;
  }

  if (isTokenExpired(token)) {
    showToast("Session expired — please re-login from the extension popup.", "error");
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
      showToast("Session expired — please re-login from the extension popup.", "error");
      return null;
    }
    return res;
  } catch (err) {
    console.error("Prompt Memory fetch error:", err);
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

async function enhancePromptStream(prompt, selectedPromptIds, onToken, onDone, inputMetadata = {}) {
  const auth = await getAuth();
  if (!auth || isTokenExpired(auth.token)) return null;

  const conversation = scrapeConversation();
  const body = {
    prompt,
    platform: window.location.hostname,
    mode: currentMode,
    conversation_context: conversation,
  };
  if (selectedPromptIds && selectedPromptIds.length > 0) {
    body.selected_prompt_ids = selectedPromptIds;
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

  try {
    const res = await fetch(`${API_URL}/enhance/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify(body),
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

async function trackPrompt(prompt) {
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
// UI: TRIGGER BUTTON
// ══════════════════════════════════════════════════════════════

function createTrigger() {
  if (document.getElementById("pm-trigger")) return;
  const btn = document.createElement("button");
  btn.id = "pm-trigger";
  btn.className = "pm-trigger";
  btn.innerHTML = "⊕";
  btn.title = "Enhance this prompt (Ctrl+Shift+E)\nShift-click for your library";
  // Click runs the thing people came for. This used to open the panel, which
  // meant the primary action sat two clicks deep behind a tab bar; the library
  // is the secondary path now, not the front door.
  btn.addEventListener("click", (e) => {
    if (e.shiftKey) togglePanel();
    else handleEnhance();
  });
  document.body.appendChild(btn);

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
  lib.innerHTML = "\u2630 Library";
  lib.title = "Your saved prompts and context (Shift-click \u2295)";
  lib.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePanel();
  });
  document.body.appendChild(lib);

  // Apply saved theme to both docked controls
  chrome.storage.local.get("pm_theme", (result) => {
    const theme = result.pm_theme || "dark";
    btn.setAttribute("data-pm-theme", theme);
    lib.setAttribute("data-pm-theme", theme);
  });
}

// ══════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUT: Ctrl+Shift+E = Instant Enhance
// ══════════════════════════════════════════════════════════════

function setupKeyboardShortcut() {
  // Primary path: Chrome intercepts the chords declared in manifest.json's
  // "commands" block at the browser level, so they never reach this page. The
  // service worker catches them and forwards them here.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "PM_COMMAND") return;
    if (msg.command === "enhance-prompt") handleEnhance();
    if (msg.command === "voice-prompt") toggleVoice();
  });

  // Fallback path: the user may have cleared or rebound the command in
  // chrome://extensions/shortcuts, in which case Chrome does not intercept and
  // the keystroke does arrive here.
  document.addEventListener("keydown", (e) => {
    // Accept Cmd on macOS as well as Ctrl. The manifest advertises
    // Command+Shift+E on Mac, but this listener only ever checked ctrlKey — so
    // the advertised Mac shortcut did nothing here.
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;

    // Compare on e.code, not e.key. With Shift held, e.key is layout-dependent
    // ("E" on US QWERTY, but a different character on many other layouts),
    // whereas e.code names the physical key.
    if (e.code === "KeyE") {
      e.preventDefault();
      handleEnhance();
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
// UI: PANEL (3 tabs: Context, Save, History)
// ══════════════════════════════════════════════════════════════

function createPanel() {
  if (document.getElementById("pm-panel")) return;

  const panel = document.createElement("div");
  panel.id = "pm-panel";
  panel.className = "pm-panel";

  panel.innerHTML = `
    <div class="pm-resize-handle" id="pm-resize-handle"></div>
    <div class="pm-header">
      <span class="pm-header-title">Prompt Memory</span>
      <span class="pm-version-badge">v4</span>
      <button class="pm-settings-toggle" id="pm-settings-toggle" title="Privacy Settings">⚙</button>
      <button class="pm-theme-toggle" id="pm-theme-toggle" title="Toggle light/dark mode">🌙</button>
      <button class="pm-header-close" id="pm-close">×</button>
    </div>
    <div class="pm-settings-panel" id="pm-settings-panel" style="display:none">
      <div class="pm-settings-row">
        <div class="pm-settings-info">
          <div class="pm-settings-label">Prompt Tracking</div>
          <div class="pm-settings-desc">Logs your submitted prompts to improve future suggestions.</div>
        </div>
        <label class="pm-toggle">
          <input type="checkbox" id="pm-tracking-toggle" checked>
          <span class="pm-toggle-slider"></span>
        </label>
      </div>
      <div class="pm-settings-row" style="margin-top:10px">
        <div class="pm-settings-info">
          <div class="pm-settings-label">Conversation Context</div>
          <div class="pm-settings-desc">Reads recent chat messages for better enhancement results.</div>
        </div>
        <label class="pm-toggle">
          <input type="checkbox" id="pm-context-toggle" checked>
          <span class="pm-toggle-slider"></span>
        </label>
      </div>
    </div>
    <div class="pm-tabs">
      <button class="pm-tab pm-active" data-tab="context">Context</button>
      <button class="pm-tab" data-tab="save">Save</button>
      <button class="pm-tab" data-tab="history">History</button>
      <button class="pm-tab" data-tab="feedback" title="Send Feedback">💬</button>
    </div>
    <div class="pm-tab-content" id="pm-tab-body"></div>
    <div class="pm-enhance-section">
      <div class="pm-usage-bar" id="pm-usage-bar" style="display:none">
        <div class="pm-usage-track"><div class="pm-usage-fill" id="pm-usage-fill" style="width:0%"></div></div>
        <span class="pm-usage-label" id="pm-usage-label"></span>
      </div>
      <div class="pm-mode-selector">
        <button class="pm-mode-pill" data-mode="quick" title="Short & sharp">⚡ Quick</button>
        <button class="pm-mode-pill pm-mode-pill-active" data-mode="deep" title="Full structured enhancement">🎯 Deep</button>
        <button class="pm-mode-pill" data-mode="creative" title="Open-ended, exploratory">✨ Creative</button>
      </div>
      <div class="pm-enhance-row">
        <button class="pm-enhance-btn" id="pm-enhance-btn">Enhance Current Prompt</button>
        <button class="pm-voice-btn" id="pm-voice-btn" title="Voice to Prompt (Ctrl+Shift+V)">🎤</button>
      </div>
      <div class="pm-enhance-hint" id="pm-enhance-hint">Ctrl+Shift+E to enhance · Ctrl+Shift+V to speak</div>
    </div>
  `;

  document.body.appendChild(panel);

  // Restore saved width + theme
  chrome.storage.local.get(["pm_panel_width", "pm_theme"], (result) => {
    if (result.pm_panel_width) {
      panel.style.width = result.pm_panel_width + "px";
    }
    applyTheme(result.pm_theme || "dark");
  });

  // Close
  document.getElementById("pm-close").addEventListener("click", () => togglePanel(false));

  // Settings toggle
  document.getElementById("pm-settings-toggle").addEventListener("click", () => {
    const settingsPanel = document.getElementById("pm-settings-panel");
    settingsPanel.style.display = settingsPanel.style.display === "none" ? "block" : "none";
  });

  // Tracking toggle
  const trackToggle = document.getElementById("pm-tracking-toggle");
  const ctxToggle = document.getElementById("pm-context-toggle");
  chrome.storage.local.get(["pm_tracking", "pm_context"], (result) => {
    trackToggle.checked = result.pm_tracking === true;   // default: OFF
    ctxToggle.checked = result.pm_context !== false;
  });
  trackToggle.addEventListener("change", () => {
    promptTrackingEnabled = trackToggle.checked;
    chrome.storage.local.set({ pm_tracking: promptTrackingEnabled });
  });
  ctxToggle.addEventListener("change", () => {
    contextEnabled = ctxToggle.checked;
    chrome.storage.local.set({ pm_context: contextEnabled });
  });

  // Theme toggle
  document.getElementById("pm-theme-toggle").addEventListener("click", () => {
    const current = panel.getAttribute("data-pm-theme") || "dark";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    chrome.storage.local.set({ pm_theme: next });
  });

  // Tabs
  panel.querySelectorAll(".pm-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      currentTab = tab.dataset.tab;
      panel.querySelectorAll(".pm-tab").forEach((t) => t.classList.remove("pm-active"));
      tab.classList.add("pm-active");
      renderTabContent();
    });
  });

  // Mode pills
  panel.querySelectorAll(".pm-mode-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentMode = btn.dataset.mode;
      panel.querySelectorAll(".pm-mode-pill").forEach((b) => b.classList.remove("pm-mode-pill-active"));
      btn.classList.add("pm-mode-pill-active");
    });
  });

  // Enhance
  document.getElementById("pm-enhance-btn").addEventListener("click", handleEnhance);

  // Voice
  document.getElementById("pm-voice-btn").addEventListener("click", toggleVoice);

  // Resize handle — drag left edge
  const handle = document.getElementById("pm-resize-handle");
  let resizing = false, startX = 0, startWidth = 0;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    resizing = true;
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    handle.classList.add("pm-resizing");
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    const diff = startX - e.clientX;
    const newWidth = Math.min(600, Math.max(320, startWidth + diff));
    panel.style.width = newWidth + "px";
    // Dragging the panel wider walks its left edge across the card.
    positionCard();
  });

  document.addEventListener("mouseup", () => {
    if (!resizing) return;
    resizing = false;
    handle.classList.remove("pm-resizing");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    chrome.storage.local.set({ pm_panel_width: panel.offsetWidth });
  });
}

function togglePanel(force) {
  const panel = document.getElementById("pm-panel");
  if (!panel) return;
  panelOpen = force !== undefined ? force : !panelOpen;
  panel.classList.toggle("pm-open", panelOpen);
  // The panel is the card's right-hand boundary, and opening or closing it
  // fires neither resize nor scroll — the only two events the card watches.
  positionCard();
  positionToasts();
  if (panelOpen) {
    // If already logged in, skip onboarding and mark as onboarded
    chrome.storage.local.get(["pm_onboarded", "token"], (result) => {
      if (result.token || result.pm_onboarded) {
        // Auto-mark as onboarded if logged in
        if (!result.pm_onboarded) {
          chrome.storage.local.set({ pm_onboarded: true });
        }
        // Remove any leftover onboarding overlays
        panel.querySelectorAll(".pm-onboarding").forEach((el) => el.remove());
        showSkeletonAndLoad();
      } else {
        showOnboarding(panel);
      }
    });
  }
}

function showSkeletonAndLoad() {
  const body = document.getElementById("pm-tab-body");
  if (body) {
    body.innerHTML = renderSkeleton(3);
    isLoadingTab = true;
  }
  fetchSavedPrompts().then(() => {
    isLoadingTab = false;
    renderTabContent();
  });
  fetchUsage();
}

// ══════════════════════════════════════════════════════════════
// ONBOARDING OVERLAY (first-time users)
// ══════════════════════════════════════════════════════════════

function showOnboarding(panel) {
  // Remove any existing onboarding overlay to prevent stacking
  panel.querySelectorAll(".pm-onboarding").forEach((el) => el.remove());

  const overlay = document.createElement("div");
  overlay.className = "pm-onboarding";
  overlay.innerHTML = `
    <div class="pm-onboarding-logo">✨</div>
    <div class="pm-onboarding-title">Welcome to Prompt Memory</div>
    <div class="pm-onboarding-subtitle">Your AI prompt engineering assistant</div>
    <div class="pm-onboarding-steps">
      <div class="pm-onboarding-step">
        <div class="pm-onboarding-icon">✍️</div>
        <div class="pm-onboarding-step-text">
          <div class="pm-onboarding-step-title">Write your prompt</div>
          <div class="pm-onboarding-step-desc">Type your prompt in any AI chat as usual</div>
        </div>
      </div>
      <div class="pm-onboarding-step">
        <div class="pm-onboarding-icon">🎯</div>
        <div class="pm-onboarding-step-text">
          <div class="pm-onboarding-step-title">Hit Enhance</div>
          <div class="pm-onboarding-step-desc">Press Ctrl+Shift+E or click Enhance — we'll rewrite it to get better AI responses</div>
        </div>
      </div>
      <div class="pm-onboarding-step">
        <div class="pm-onboarding-icon">💾</div>
        <div class="pm-onboarding-step-text">
          <div class="pm-onboarding-step-title">Save & reuse</div>
          <div class="pm-onboarding-step-desc">Save great prompts to your library. Select them as context for future enhancements</div>
        </div>
      </div>
    </div>
    <button class="pm-onboarding-cta" id="pm-onboarding-start">Get Started</button>
  `;
  panel.appendChild(overlay);

  document.getElementById("pm-onboarding-start").addEventListener("click", () => {
    chrome.storage.local.set({ pm_onboarded: true });
    overlay.style.animation = "pm-fadeIn 0.3s ease reverse";
    setTimeout(() => {
      overlay.remove();
      showSkeletonAndLoad();
    }, 280);
  });
}

// ══════════════════════════════════════════════════════════════
// SKELETON LOADERS
// ══════════════════════════════════════════════════════════════

function renderSkeleton(count = 3) {
  let items = "";
  for (let i = 0; i < count; i++) {
    items += `
      <div class="pm-skeleton-item">
        <div class="pm-skeleton-checkbox"></div>
        <div class="pm-skeleton-body">
          <div class="pm-skeleton-line"></div>
          <div class="pm-skeleton-line"></div>
          <div class="pm-skeleton-line"></div>
        </div>
      </div>`;
  }
  return `<div class="pm-skeleton">${items}</div>`;
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

function updateUsageBar() {
  const bar = document.getElementById("pm-usage-bar");
  const fill = document.getElementById("pm-usage-fill");
  const label = document.getElementById("pm-usage-label");
  if (!bar || !fill || !label) return;

  const pct = Math.min(100, Math.round((usageData.count / usageData.limit) * 100));
  bar.style.display = "flex";
  fill.style.width = pct + "%";
  fill.className = pct >= 80 ? "pm-usage-fill pm-usage-warn" : "pm-usage-fill";

  // The number tracks the bar. It was --pm-text-muted at every level — the
  // dimmest token in the palette — so at 15/15, the one moment the count
  // decides whether the next thing you try will work at all, it was the
  // hardest thing in the panel to read, sitting beside an alarm-red bar.
  label.className =
    pct >= 100 ? "pm-usage-label pm-usage-label-spent"
    : pct >= 80 ? "pm-usage-label pm-usage-label-warn"
    : "pm-usage-label";
  label.textContent =
    pct >= 100
      ? `${usageData.count}/${usageData.limit} today \u2014 none left`
      : `${usageData.count}/${usageData.limit} today`;
}

// ══════════════════════════════════════════════════════════════
// RENDER: TAB CONTENT
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

function renderTabContent() {
  const body = document.getElementById("pm-tab-body");
  if (!body) return;

  if (currentTab === "context") {
    renderContextTab(body);
  } else if (currentTab === "save") {
    renderSaveTab(body);
  } else if (currentTab === "history") {
    renderHistoryTab(body);
  } else if (currentTab === "feedback") {
    renderFeedbackTab(body);
  }

  // After the tab's own markup lands, so the measurement sees real content.
  watchScrollable(body);
  markScrollable(body);
}

// ══════════════════════════════════════════════════════════════
// RENDER: CONTEXT TAB (with search + checkboxes)
// ══════════════════════════════════════════════════════════════

function renderContextTab(container) {
  let html = `<div class="pm-search-row">
    <input type="text" class="pm-search-input" id="pm-search" placeholder="Search saved prompts..." value="${escHtml(searchQuery)}" />
  </div>`;

  const filtered = savedPrompts.filter((p) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const matchTitle = (p.title || "").toLowerCase().includes(q);
    const matchContent = (p.content || "").toLowerCase().includes(q);
    const matchTags = (p.tags || []).some((t) => t.toLowerCase().includes(q));
    return matchTitle || matchContent || matchTags;
  });

  if (savedPrompts.length === 0) {
    html += `<div class="pm-prompts-empty">No saved prompts yet.<br>Switch to the Save tab to add one.</div>`;
    container.innerHTML = html;
    _bindSearch(container);
    return;
  }

  if (filtered.length === 0) {
    html += `<div class="pm-prompts-empty">No prompts match "${escHtml(searchQuery)}"</div>`;
    container.innerHTML = html;
    _bindSearch(container);
    return;
  }

  container.innerHTML = html;
  _bindSearch(container);

  filtered.forEach((p) => {
    const item = document.createElement("div");
    item.className = `pm-prompt-item${selectedIds.has(p.id) ? " pm-checked" : ""}`;

    const displayTitle = p.title || truncate(p.content, 40);
    const preview = truncate(p.content, 80);
    const tagsHtml =
      p.tags && p.tags.length > 0
        ? `<div class="pm-tags">${p.tags.map((t) => `<span class="pm-tag">${escHtml(t)}</span>`).join("")}</div>`
        : "";

    item.innerHTML = `
      <input type="checkbox" class="pm-checkbox" ${selectedIds.has(p.id) ? "checked" : ""}>
      <div class="pm-prompt-body">
        <div class="pm-prompt-title">${escHtml(displayTitle)}</div>
        <div class="pm-prompt-preview">${escHtml(preview)}</div>
        ${tagsHtml}
      </div>
      <div class="pm-prompt-actions">
        <button class="pm-action-btn pm-view" title="View">◎</button>
        <button class="pm-action-btn pm-edit" title="Edit">✎</button>
        <button class="pm-action-btn pm-delete" title="Delete">✕</button>
      </div>
    `;

    const checkbox = item.querySelector(".pm-checkbox");
    item.addEventListener("click", (e) => {
      if (e.target.closest(".pm-action-btn")) return;
      if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
      if (checkbox.checked) {
        selectedIds.add(p.id);
        item.classList.add("pm-checked");
      } else {
        selectedIds.delete(p.id);
        item.classList.remove("pm-checked");
      }
      updateEnhanceHint();
    });

    item.querySelector(".pm-view").addEventListener("click", (e) => {
      e.stopPropagation();
      showModal("Saved Prompt", p.content, [{ label: "Close", action: "close", style: "secondary" }]);
    });

    item.querySelector(".pm-edit").addEventListener("click", (e) => {
      e.stopPropagation();
      showEditModal(p);
    });

    item.querySelector(".pm-delete").addEventListener("click", (e) => {
      e.stopPropagation();
      showModal(
        "Delete Prompt",
        `Are you sure you want to delete this prompt?\n\n"${truncate(p.content, 100)}"`,
        [
          { label: "Cancel", action: "close", style: "secondary" },
          {
            label: "Delete",
            style: "danger",
            action: async () => {
              const ok = await deleteSavedPrompt(p.id);
              if (ok) {
                selectedIds.delete(p.id);
                await fetchSavedPrompts();
                renderTabContent();
              }
              closeModal();
            },
          },
        ]
      );
    });

    container.appendChild(item);
  });

  updateEnhanceHint();
}

function _bindSearch(container) {
  const input = container.querySelector("#pm-search");
  if (input) {
    input.addEventListener("input", (e) => {
      searchQuery = e.target.value;
      renderContextTab(container);
      const newInput = container.querySelector("#pm-search");
      if (newInput) {
        newInput.focus();
        newInput.selectionStart = newInput.selectionEnd = searchQuery.length;
      }
    });
  }
}

function updateEnhanceHint() {
  const hint = document.getElementById("pm-enhance-hint");
  if (!hint) return;
  const count = selectedIds.size;
  if (count > 0) {
    hint.textContent = `${count} prompt${count > 1 ? "s" : ""} selected · Ctrl+Shift+E`;
  } else {
    hint.textContent = "Ctrl+Shift+E for instant enhance";
  }
}

// ══════════════════════════════════════════════════════════════
// RENDER: SAVE TAB
// ══════════════════════════════════════════════════════════════

function renderSaveTab(container) {
  const currentText = getCurrentInputText();

  container.innerHTML = `
    <div class="pm-save-form">
      <div class="pm-field">
        <label class="pm-label">Prompt content</label>
        <textarea class="pm-textarea" id="pm-save-content" placeholder="Paste or type the prompt you want to save...">${escHtml(currentText)}</textarea>
      </div>
      <div class="pm-field">
        <label class="pm-label">Title <span style="color:var(--pm-text-muted)">(optional)</span></label>
        <input class="pm-input" id="pm-save-title" placeholder="e.g. Code review template" />
      </div>
      <div class="pm-field">
        <label class="pm-label">Tags <span style="color:var(--pm-text-muted)">(optional, comma-separated)</span></label>
        <input class="pm-input" id="pm-save-tags" placeholder="e.g. coding, review" />
      </div>
      <div class="pm-btn-row">
        <button class="pm-btn pm-btn-primary" id="pm-save-btn" style="flex:1">Save Prompt</button>
      </div>
      <div class="pm-status" id="pm-save-status"></div>
    </div>
  `;

  document.getElementById("pm-save-btn").addEventListener("click", async () => {
    const content = document.getElementById("pm-save-content").value.trim();
    if (!content) {
      setStatus("pm-save-status", "Please enter prompt content.", "error");
      return;
    }
    const title = document.getElementById("pm-save-title").value.trim();
    const tagsRaw = document.getElementById("pm-save-tags").value.trim();
    const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter((t) => t) : [];

    const btn = document.getElementById("pm-save-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";

    const outcome = await createSavedPrompt(content, title, tags);
    if (outcome === "saved") {
      setStatus("pm-save-status", "Prompt saved successfully.", "success");
      document.getElementById("pm-save-content").value = "";
      document.getElementById("pm-save-title").value = "";
      document.getElementById("pm-save-tags").value = "";
      await fetchSavedPrompts();
    } else if (outcome === "duplicate") {
      // The form is deliberately left filled: nothing was written, and emptying
      // it is the gesture that means it was.
      setStatus("pm-save-status", "That prompt is already in your library.", "info");
    } else {
      setStatus("pm-save-status", "Failed to save. Check login status.", "error");
    }
    btn.disabled = false;
    btn.textContent = "Save Prompt";
  });
}

// ══════════════════════════════════════════════════════════════
// RENDER: HISTORY TAB
// ══════════════════════════════════════════════════════════════

function renderHistoryTab(container) {
  container.innerHTML = `<div class="pm-prompts-empty">Loading history...</div>`;

  fetchEnhanceHistory().then((history) => {
    if (history.length === 0) {
      container.innerHTML = `<div class="pm-prompts-empty">No enhancement history yet.<br>Enhance a prompt to see it here.</div>`;
      markScrollable(container);
      return;
    }

    container.innerHTML = "";
    history.forEach((item) => {
      const card = document.createElement("div");
      card.className = "pm-history-card";

      const timeAgo = item.timestamp ? getTimeAgo(item.timestamp) : "";
      const modeBadge = { quick: "⚡", deep: "🎯", creative: "✨" }[item.mode] || "🎯";

      card.innerHTML = `
        <div class="pm-history-header">
          <span class="pm-history-mode">${modeBadge} ${item.mode || "deep"}</span>
          <span class="pm-history-time">${timeAgo}</span>
        </div>
        <div class="pm-history-original">${escHtml(truncate(item.original, 120))}</div>
        <div class="pm-history-arrow">↓</div>
        <div class="pm-history-enhanced">${escHtml(truncate(item.enhanced, 150))}</div>
        <div class="pm-history-footer">
          <span class="pm-history-latency">${item.latency}s</span>
          <button class="pm-action-btn pm-history-use" title="Use this prompt">↗</button>
          <button class="pm-action-btn pm-history-copy" title="Copy enhanced">📋</button>
        </div>
      `;

      card.querySelector(".pm-history-use").addEventListener("click", () => {
        applyOrFallback(item.enhanced);
      });

      card.querySelector(".pm-history-copy").addEventListener("click", () => {
        navigator.clipboard.writeText(item.enhanced);
        showToast("Copied to clipboard!", "success");
      });

      container.appendChild(card);
    });
    // The tab was measured before this async fetch completed. Recalculate the
    // parent marker now that the history cards are actually in the DOM.
    markScrollable(container);
  });
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

// ══════════════════════════════════════════════════════════════
// RENDER: FEEDBACK TAB
// ══════════════════════════════════════════════════════════════

function renderFeedbackTab(container) {
  // Pre-fill email from chrome.storage
  chrome.storage.local.get(["email"], (result) => {
    const userEmail = result.email || "";

    container.innerHTML = `
      <div class="pm-save-form">
        <div class="pm-feedback-header">
          <div class="pm-feedback-icon">💬</div>
          <div class="pm-feedback-title">Send Feedback</div>
          <div class="pm-feedback-subtitle">Bug reports, feature requests, or general feedback</div>
        </div>
        <div class="pm-field">
          <label class="pm-label">Type</label>
          <select class="pm-input pm-select" id="pm-feedback-type">
            <option value="bug">🐛 Bug Report</option>
            <option value="feature">💡 Feature Request</option>
            <option value="general" selected>💬 General Feedback</option>
          </select>
        </div>
        <div class="pm-field">
          <label class="pm-label">Message</label>
          <textarea class="pm-textarea" id="pm-feedback-message" rows="4" placeholder="Describe the issue, suggestion, or feedback..."></textarea>
        </div>
        <div class="pm-field">
          <label class="pm-label">Email <span style="color:var(--pm-text-muted)">(for follow-ups)</span></label>
          <input class="pm-input" id="pm-feedback-email" type="email" value="${escHtml(userEmail)}" placeholder="your@email.com" />
        </div>
        <div class="pm-btn-row">
          <button class="pm-btn pm-btn-primary" id="pm-feedback-submit" style="flex:1">Submit Feedback</button>
        </div>
        <div class="pm-status" id="pm-feedback-status"></div>
        <div class="pm-feedback-recent" id="pm-feedback-recent"></div>
      </div>
    `;

    // Submit handler
    document.getElementById("pm-feedback-submit").addEventListener("click", async () => {
      const type = document.getElementById("pm-feedback-type").value;
      const message = document.getElementById("pm-feedback-message").value.trim();
      const email = document.getElementById("pm-feedback-email").value.trim();

      if (!message || message.length < 5) {
        setStatus("pm-feedback-status", "Please write at least a few words.", "error");
        return;
      }

      const btn = document.getElementById("pm-feedback-submit");
      btn.disabled = true;
      btn.textContent = "Sending...";

      const ok = await submitFeedback(type, message, email);
      if (ok) {
        setStatus("pm-feedback-status", "Thank you! Your feedback has been received. ✓", "success");
        document.getElementById("pm-feedback-message").value = "";
        // Refresh the recent list
        loadRecentFeedback();
      } else {
        setStatus("pm-feedback-status", "Failed to send. Check your login status.", "error");
      }
      btn.disabled = false;
      btn.textContent = "Submit Feedback";
    });

    // Load recent feedback
    loadRecentFeedback();
  });
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

function loadRecentFeedback() {
  const recentContainer = document.getElementById("pm-feedback-recent");
  if (!recentContainer) return;

  recentContainer.innerHTML = `<div class="pm-prompts-empty" style="padding:8px 0;font-size:11px;">Loading recent...</div>`;

  fetchMyFeedback().then((items) => {
    if (items.length === 0) {
      recentContainer.innerHTML = "";
      markScrollable(document.getElementById("pm-tab-body"));
      return;
    }

    const typeIcons = { bug: "🐛", feature: "💡", general: "💬" };
    const statusIcons = { new: "📨", reviewed: "👀", resolved: "✅" };

    let html = `<div class="pm-feedback-recent-title">Recent Feedback</div>`;
    items.slice(0, 3).forEach((item) => {
      const icon = typeIcons[item.type] || "💬";
      const statusIcon = statusIcons[item.status] || "📨";
      const time = item.timestamp ? getTimeAgo(item.timestamp) : "";
      html += `
        <div class="pm-feedback-recent-item">
          <span class="pm-feedback-recent-icon">${icon}</span>
          <span class="pm-feedback-recent-msg">${escHtml(item.message)}</span>
          <span class="pm-feedback-recent-meta">${statusIcon} ${time}</span>
        </div>
      `;
    });
    recentContainer.innerHTML = html;
    // Recent feedback arrives after renderTabContent's initial measurement.
    markScrollable(document.getElementById("pm-tab-body"));
  });
}

// ══════════════════════════════════════════════════════════════
// ENHANCE HANDLER (streaming)
// ══════════════════════════════════════════════════════════════

/** Open the extension's own settings UI. */
function openSettings() {
  chrome.runtime.sendMessage({ type: "PM_OPEN_OPTIONS" }, () => {
    if (chrome.runtime.lastError) {
      showToast("Click the Prompt Memory icon in your toolbar to open settings.", "info");
    }
  });
}

// Guards against a second enhancement starting while one is in flight. Two
// concurrent streams wrote into the same modal and the same composer, and on
// the shared key that burned two of a user's fifteen daily enhancements for
// one result.
let enhanceInFlight = false;

async function handleEnhance() {
  if (enhanceInFlight) {
    showToast("Already enhancing — hang on a moment.", "info");
    return;
  }

  const inputText = getCurrentInputText();
  if (!inputText || inputText.trim().length < 3) {
    showToast("Type a prompt in the chat input first.", "error");
    return;
  }

  // Ask the service worker how this request should be routed. It owns the API
  // key, so the decision cannot be made here.
  const route = await askWorker({ type: "PM_GET_ROUTE" });
  if (!route) {
    // The worker is unreachable. Almost always this tab's content script was
    // orphaned by an extension update or reload — the page needs refreshing,
    // which is a different problem from "you have not set anything up yet".
    showToast("Prompt Memory was updated — please reload this page.", "error");
    return;
  }
  if (route.route === "expired") {
    // Signed in at some point, token past its 7-day life, and no API key to
    // fall back on. Previously this routed at the backend anyway and produced
    // an unexplained failure on every attempt.
    showToast("Your session expired — please sign in again.", "error");
    openSettings();
    return;
  }
  if (route.route === "none") {
    // Neither signed in nor holding a key. Previously this said "Please log in
    // first" and stopped — the extension delivered nothing at all until the
    // user completed a Google OAuth flow. Now there are two ways forward and
    // the faster one needs no account.
    showSetupRequiredModal();
    return;
  }

  const btn = document.getElementById("pm-enhance-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Enhancing...";
  }

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
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Enhance Current Prompt";
    }
  }
}

/** No account, no server: the service worker calls the user's own provider. */
async function runDirectEnhance(inputText, route) {
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: "pm-stream" });
    let parts = [];
    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch { /* already closed */ }
      fn();
      resolve();
    };

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
            mode: currentMode,
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

    port.postMessage({ type: "PM_ENHANCE_STREAM", prompt: inputText, mode: currentMode });
  });
}

/** Signed in: go through the backend so memory features still apply. */
async function runBackendEnhance(inputText, inputMetadata = {}) {
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
      lastEnhanceResult = {
        original: inputText,
        enhanced: parts.join(""),
        log_id: metadata.log_id,
        latency: metadata.latency,
        mode: metadata.mode,
        model: metadata.model,
        context_used: metadata.context_used,
      };
      finalizeStreamingModal(lastEnhanceResult);

      if (metadata.usage_today) {
        usageData.count = metadata.usage_today.used;
        usageData.limit = metadata.usage_today.limit;
      } else {
        usageData.count++;
      }
      updateUsageBar();
    },
    inputMetadata
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
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("Prompt Memory: worker unreachable", chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response);
      });
    } catch (e) {
      console.warn("Prompt Memory: worker call failed", e);
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
// keys: Tab accepts, Esc dismisses.
//
// The four entry points below keep the names the streaming flow already calls,
// so runBackendEnhance/runDirectEnhance are untouched.

let cardState = "idle";        // idle | streaming | ready | error
let cardResult = null;
let cardShowingOriginal = false;
let cardOriginal = "";
let cardReposition = null;
let cardHasBaseline = false;

// The composer text this rewrite was actually built from, normalised.
//
// Tracked as TEXT rather than as an "edited" flag on purpose. A flag cannot be
// un-set: undoing an edit would leave the card stranded as stale forever, and a
// stray trailing space would trigger it. Comparing text means undo restores the
// card to fresh for free, and whitespace churn is invisible.
let cardBasedOn = "";
let cardStale = false;

function getOrCreateCard() {
  let card = document.getElementById("pm-card");
  if (!card) {
    card = document.createElement("div");
    card.id = "pm-card";
    card.className = "pm-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Enhanced prompt");
    document.body.appendChild(card);

    chrome.storage.local.get("pm_theme", (r) =>
      card.setAttribute("data-pm-theme", r.pm_theme || "dark")
    );
  }
  return card;
}

/**
 * Sit the card directly above the composer.
 *
 * Anchored rather than centred because the composer is where the user is
 * already looking, and because a rewrite has to be judged against the
 * conversation it belongs to — which a centred overlay hides.
 */
function positionCard() {
  const card = document.getElementById("pm-card");
  const composer = findComposer();
  if (!card || !composer) return;

  const box = composer.getBoundingClientRect();
  const gap = 10;
  const margin = 12;

  // The open panel is a hard right-hand boundary. The card outranks it in the
  // stacking order — deliberately, since nothing may cover a card whose Tab key
  // is live — which means an overlap would hide the panel's own controls. It
  // hid the Deep/Creative toggle and the left edge of Enhance Current Prompt.
  // Ordering decides who wins a collision; this is what stops there being one.
  const panel = document.querySelector("#pm-panel.pm-open");
  const rightBound = panel
    ? Math.min(window.innerWidth - margin, panel.getBoundingClientRect().left - gap)
    : window.innerWidth - margin;

  const width = Math.min(Math.max(box.width, 380), 620, Math.max(240, rightBound - margin));
  let left = box.left + (box.width - width) / 2;
  left = Math.max(margin, Math.min(left, rightBound - width));

  card.style.width = width + "px";
  card.style.left = left + "px";

  // Everything that is not the scrolling rewrite: stale bar, chip, footer.
  // Measured rather than assumed, because the stale bar comes and goes.
  const textEl = card.querySelector(".pm-card-text");
  // Not named `chrome`: this file reaches for the extension API global by that
  // name throughout, and shadowing it inside a function is a trap for the next
  // line added here.
  const frame = card.offsetHeight - (textEl ? textEl.clientHeight : 0);

  const roomAbove = box.top - gap - margin;
  const roomBelow = window.innerHeight - box.bottom - gap - margin;

  // Above by preference; below when the card genuinely does not fit up top and
  // there is more room down there.
  const useAbove = card.offsetHeight <= roomAbove || roomAbove >= roomBelow;
  const room = useAbove ? roomAbove : roomBelow;

  // Give the rewrite whatever is left over, rather than letting the card grow
  // past the space it has. The old code clamped the card's TOP against the
  // viewport instead, so a card too tall to fit below slid upwards over the
  // composer — covering the very text it is a comment on, and doing it exactly
  // when the stale bar made the card taller. MIN_TEXT stops a short window
  // collapsing the rewrite to a sliver.
  const MIN_TEXT = 88;
  card.style.setProperty("--pm-card-text-max", Math.max(MIN_TEXT, room - frame) + "px");

  const height = card.offsetHeight || 160;
  card.style.top = (useAbove ? Math.max(margin, box.top - gap - height) : box.bottom + gap) + "px";

  // The height budget just changed, so whether anything is still below the fold
  // changed with it.
  markScrollable(textEl);
}

function openCard(innerHTML) {
  const card = getOrCreateCard();
  card.innerHTML = innerHTML;
  positionCard();
  requestAnimationFrame(() => card.classList.add("pm-card-visible"));

  if (!cardReposition) {
    cardReposition = () => positionCard();
    window.addEventListener("resize", cardReposition, true);
    window.addEventListener("scroll", cardReposition, true);
  }
  return card;
}

function closeCard() {
  const card = document.getElementById("pm-card");
  if (card) {
    card.classList.remove("pm-card-visible");
    card.remove();
  }
  if (cardReposition) {
    window.removeEventListener("resize", cardReposition, true);
    window.removeEventListener("scroll", cardReposition, true);
    cardReposition = null;
  }
  cardState = "idle";
  cardResult = null;
  cardShowingOriginal = false;
  cardBasedOn = "";
  cardHasBaseline = false;
  cardStale = false;
}

function cardFoot(parts) {
  return `<div class="pm-card-foot">${parts.join("")}</div>`;
}

const cardKey = (k) => `<span class="pm-card-key">${k}</span>`;

// ── Entry point 1: the flow is starting ──
function showStreamingDiffModal(originalText) {
  cardOriginal = originalText;
  cardBasedOn = norm(originalText);
  cardHasBaseline = true;
  cardStale = false;
  cardState = "streaming";
  cardShowingOriginal = false;
  openCard(
    `<div class="pm-card-text" id="pm-stream-target"><span class="pm-card-cursor"></span></div>` +
    cardFoot([
      `<button class="pm-card-act" id="pm-card-cancel">${cardKey("esc")} cancel</button>`,
      `<span class="pm-card-spacer"></span>`,
      `<span class="pm-card-meta">rewriting…</span>`,
    ])
  );
  document.getElementById("pm-card-cancel")?.addEventListener("click", closeCard);
}

// ── Entry point 2: tokens arriving ──
function updateStreamingText(text) {
  const target = document.getElementById("pm-stream-target");
  if (!target) return;
  target.innerHTML = escHtml(text) + '<span class="pm-card-cursor"></span>';
  positionCard();
}

// ── Entry point 3: finished ──
function finalizeStreamingModal(result) {
  showDiffModal(result);
}

// ── Entry point 4: failed ──
function failStreamingModal(message) {
  cardState = "error";
  openCard(
    `<div class="pm-card-text pm-card-error">${escHtml(message)}</div>` +
    cardFoot([
      `<button class="pm-card-act" id="pm-card-retry">${cardKey("\u2318\u21B5")} try again</button>`,
      `<button class="pm-card-act" id="pm-card-dismiss">${cardKey("esc")} dismiss</button>`,
    ])
  );
  document.getElementById("pm-card-retry")?.addEventListener("click", () => { closeCard(); handleEnhance(); });
  document.getElementById("pm-card-dismiss")?.addEventListener("click", closeCard);
}

/** The finished state. Named showDiffModal because several other flows
 *  (voice, re-enhance, feedback) already call it. */
function showDiffModal(result) {
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
  cardStale = Boolean(cardBasedOn) && norm(getCurrentInputText()) !== cardBasedOn;

  const body = cardShowingOriginal
    ? `<div class="pm-card-text pm-card-original">${escHtml(result.original || cardOriginal)}</div>`
    : `<div class="pm-card-text">${escHtml(result.enhanced)}</div>`;

  // Named rather than merely dimmed. "Why is this greyed out" is a worse
  // question to leave a user holding than one line of explanation.
  //
  // The wording follows the toggle. Under \, the body IS the earlier text, so
  // calling it "a rewrite for the earlier text" would be pointing at the wrong
  // thing — the user would look for a staleness that is not on screen.
  const staleFlag = cardStale
    ? `<div class="pm-card-stale-flag">\u26A0 ${cardShowingOriginal
        ? "prompt changed \u2014 this is the text the rewrite was built from"
        : "prompt changed \u2014 this rewrite is for the earlier text"}</div>`
    : "";

  // Only shown when a saved prompt actually shaped the rewrite. The old footer
  // printed four zeros on every result, which teaches people to stop reading it.
  // Degrade by what the response actually carries. The two enhance endpoints
  // returned different shapes — only the non-streaming one included
  // context_details — so reading details alone meant the chip never appeared
  // on the streaming path, which is the path the extension uses.
  let chip = "";
  const matched = result.context_details?.auto_matched_prompts?.[0];
  const autoCount = result.context_used?.auto_matched || 0;
  const selectedCount = result.context_used?.selected || 0;
  if (!cardShowingOriginal) {
    if (matched && (matched.title || matched.content)) {
      const label = (matched.title || matched.content || "saved prompt").slice(0, 48);
      chip = `<div class="pm-card-chip" title="This rewrite drew on a saved prompt">\u21B3 ${escHtml(label)}</div>`;
    } else if (autoCount > 0) {
      chip = `<div class="pm-card-chip">\u21B3 ${autoCount} saved prompt${autoCount > 1 ? "s" : ""} used</div>`;
    } else if (selectedCount > 0) {
      chip = `<div class="pm-card-chip">\u21B3 ${selectedCount} selected</div>`;
    }
  }

  const truncatedNote = result.truncated
    ? `<span class="pm-card-meta" style="color:var(--pm-danger)">cut short</span>`
    : `<span class="pm-card-meta">${result.latency ? result.latency + "s" : ""}</span>`;

  // One footer, with accept swapped for its disabled twin. The stale variant
  // used to be a separate, shorter list, which silently dropped \ original and
  // ⌘S save while their key handlers below stayed live. A footer that stops
  // listing keys that still work is worse than one that never listed them, and
  // the reflow made the card visibly rebuild itself the moment you typed.
  const accept = cardStale
    ? `<span class="pm-card-act pm-card-disabled" title="The prompt changed — redo first">${cardKey("Tab")} accept</span>`
    : `<button class="pm-card-act pm-card-primary" id="pm-card-accept">${cardKey("Tab")} accept</button>`;

  const actions = [
    // Accept is shown, not hidden: the key still means accept, it simply has
    // nothing safe to accept. Hiding it would just look like the footer
    // changed for no reason.
    accept,
    ...(cardStale
      ? [`<button class="pm-card-act pm-card-redo" id="pm-card-redo">${cardKey("⌘↵")} redo</button>`]
      : []),
    `<button class="pm-card-act" id="pm-card-close">${cardKey("esc")} dismiss</button>`,
    `<button class="pm-card-act" id="pm-card-toggle">${cardKey("\\")} ${cardShowingOriginal ? "rewrite" : "original"}</button>`,
    `<button class="pm-card-act" id="pm-card-save">${cardKey("⌘S")} save</button>`,
    `<span class="pm-card-spacer"></span>`,
    // No "stale" caption here. The bar at the top of the card already says it,
    // at greater length and in the place the eye lands first.
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
  const card = openCard(staleFlag + body + chip + cardFoot(actions));
  card.classList.toggle("pm-card-stale", cardStale);

  const textEl = card.querySelector(".pm-card-text");
  if (textEl && prevScroll && textEl.textContent === prevContent) {
    textEl.scrollTop = prevScroll;
  }
  watchScrollable(textEl);
  markScrollable(textEl);

  document.getElementById("pm-card-accept")?.addEventListener("click", acceptCard);
  document.getElementById("pm-card-close")?.addEventListener("click", closeCard);
  document.getElementById("pm-card-redo")?.addEventListener("click", redoCard);
  document.getElementById("pm-card-toggle")?.addEventListener("click", () => {
    cardShowingOriginal = !cardShowingOriginal;
    showDiffModal(cardResult);
  });
  document.getElementById("pm-card-save")?.addEventListener("click", saveCard);
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
  const stale = Boolean(cardBasedOn) && norm(getCurrentInputText()) !== cardBasedOn;
  if (stale === cardStale) return;
  cardStale = stale;
  showDiffModal(cardResult);
}

// The whole mechanism. Listening for edits anywhere is fine because
// refreshCardStaleness() is a no-op unless a finished rewrite is on screen.
document.addEventListener("input", refreshCardStaleness, true);

/** Write the rewrite into the composer. */
async function acceptCard() {
  if (cardState !== "ready" || !cardResult) return;
  if (cardStale) {
    // The dangerous action. Accepting here would replace what the user just
    // typed with a rewrite of text that no longer exists — and it would report
    // success, correctly, because the write really did land. Their work is what
    // would be destroyed.
    showToast("The prompt changed — press ⌘↵ to redo it first.", "error");
    return;
  }
  const text = cardShowingOriginal ? (cardResult.original || cardOriginal) : cardResult.enhanced;
  const result = cardResult;
  closeCard();

  // One event, one toast. The feedback toast carries the confirmation itself,
  // so applyOrFallback is told to stay quiet on success — but only when there
  // is actually something to rate. Without a log_id the rating cannot be sent
  // anywhere, and asking anyway spends the user's attention on nothing.
  const canRate = Boolean(result.log_id);
  const applied = await applyOrFallback(text, canRate ? null : "Applied");
  if (applied && canRate) showFeedbackToast(result);
}

async function saveCard() {
  if (!cardResult) return;
  const outcome = await createSavedPrompt(cardResult.enhanced, null, []);
  if (outcome === "duplicate") {
    showToast("Already in your library", "info");
    return;
  }
  const saved = outcome === "saved";
  showToast(saved ? "Saved to your library" : "Could not save", saved ? "success" : "error");
  if (saved) fetchSavedPrompts();
}

// ── Keymap ──
// Only active while the card is open, so Tab keeps its normal meaning
// everywhere else on the page.
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

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.querySelector(".pm-voice-overlay.pm-visible")) {
    e.preventDefault();
    e.stopPropagation();
    cancelVoice();
    return;
  }
  if (cardState === "idle") return;
  const card = document.getElementById("pm-card");
  if (!card) return;
  if (overlayHasInput()) return;

  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCard(); return; }
  if (cardState !== "ready") return;

  // Redo, while the card is open. Scoped to the card's lifetime so the chord
  // keeps its normal meaning on the host page the rest of the time.
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault(); e.stopPropagation(); redoCard(); return;
  }

  if (e.key === "Tab") {
    e.preventDefault(); e.stopPropagation();
    // Tab means accept, always. When there is nothing safe to accept it does
    // nothing and says why — a key that sometimes accepts and sometimes spends
    // quota is a key you stop trusting.
    acceptCard();
    return;
  }
  if (e.key === "\\") {
    e.preventDefault(); e.stopPropagation();
    cardShowingOriginal = !cardShowingOriginal;
    showDiffModal(cardResult);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
    e.preventDefault(); e.stopPropagation(); saveCard(); return;
  }
}, true);

function showSetupRequiredModal() {
  const overlay = getOrCreateModalOverlay();
  const modal = overlay.querySelector(".pm-modal");

  modal.innerHTML = `
    <div class="pm-modal-header">
      <span class="pm-modal-title">One-time setup</span>
      <button class="pm-header-close pm-modal-close-btn">×</button>
    </div>
    <div class="pm-modal-body">
      <p class="pm-setup-intro">Prompt Memory needs an AI model to rewrite your prompts. Pick either option — both are free.</p>

      <div class="pm-setup-option pm-setup-option-primary">
        <div class="pm-setup-badge">Recommended · no account needed</div>
        <div class="pm-setup-title">Use your own free Groq key</div>
        <div class="pm-setup-desc">
          Takes about a minute. Free, no credit card, and it gives you
          <strong>1,000 enhancements a day</strong> instead of the 15 we can
          share. Your prompts go straight from your browser to Groq — they never
          touch our server.
        </div>
        <button class="pm-btn pm-btn-primary" id="pm-setup-byok">Add my key</button>
      </div>

      <div class="pm-setup-option">
        <div class="pm-setup-title">Or sign in with Google</div>
        <div class="pm-setup-desc">
          Uses our shared key — capped at 15 enhancements a day — and unlocks
          saved prompts, history, and context from your past prompts.
        </div>
        <button class="pm-btn pm-btn-secondary" id="pm-setup-signin">Sign in</button>
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
    openSettings();
  });
  modal.querySelector("#pm-setup-signin")?.addEventListener("click", () => {
    closeModal();
    openSettings();
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
  chrome.storage.local.get("pm_theme", (r) =>
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

/**
 * The rewrite landed, and how was it?
 *
 * One toast for one event. This used to be the second of two: applyOrFallback
 * raised "Applied" and this covered it a frame later, so the answer to "did
 * that work?" was never actually visible. The confirmation is now the first
 * thing in this toast, and the rating is the favour asked afterwards.
 */
function showFeedbackToast(result) {
  document.getElementById("pm-feedback-toast")?.remove();

  const stack = getOrCreateToastStack();
  const toast = document.createElement("div");
  toast.id = "pm-feedback-toast";
  toast.className = "pm-feedback-toast";
  toast.innerHTML = `
    <span class="pm-fb-done">\u2713 Applied</span>
    <span class="pm-fb-sep"></span>
    <span class="pm-fb-ask">How was it?</span>
    <button class="pm-fb-btn pm-fb-up" title="Good" aria-label="Good">\u{1F44D}</button>
    <button class="pm-fb-btn pm-fb-down" title="Bad" aria-label="Bad">\u{1F44E}</button>
    <button class="pm-fb-close" title="Dismiss" aria-label="Dismiss">\u00D7</button>
  `;

  stack.appendChild(toast);
  positionToasts();
  requestAnimationFrame(() => {
    toast.classList.add("pm-toast-visible");
    positionToasts();
  });

  const autoDismiss = setTimeout(() => dismissToast(toast), 8000);

  const answer = (rating, reply) => {
    clearTimeout(autoDismiss);
    sendFeedback(result.log_id, rating, result.original, result.enhanced);
    toast.innerHTML = `<span class="pm-fb-done">${reply}</span>`;
    positionToasts();
    setTimeout(() => dismissToast(toast), 1400);
  };

  toast.querySelector(".pm-fb-up").addEventListener("click", () => answer("up", "Thanks \u{1F3AF}"));
  toast.querySelector(".pm-fb-down").addEventListener("click", () => answer("down", "Got it \u2014 we'll improve."));
  toast.querySelector(".pm-fb-close").addEventListener("click", () => {
    clearTimeout(autoDismiss);
    dismissToast(toast);
  });
}

function showToast(message, type = "info") {
  document.getElementById("pm-toast")?.remove();

  const stack = getOrCreateToastStack();
  const toast = document.createElement("div");
  toast.id = "pm-toast";
  toast.className = `pm-toast pm-toast-${type}`;
  toast.textContent = message;

  // Before the feedback toast when both are up, so the plain status line reads
  // first and the thing with buttons sits nearest the card.
  stack.insertBefore(toast, stack.firstChild);
  positionToasts();
  requestAnimationFrame(() => {
    toast.classList.add("pm-toast-visible");
    positionToasts();
  });

  setTimeout(() => dismissToast(toast), 3000);
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
      renderTabContent();
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
    <div class="pm-modal-body">${escHtml(body)}</div>
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
      document.getElementById("pm-panel")?.getAttribute("data-pm-theme") || "dark"
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
function clearComposer(el) {
  el.focus();
  selectAllIn(el);
  try {
    if (document.execCommand("delete", false)) return;
  } catch { /* fall through */ }
  el.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true, cancelable: true, inputType: "deleteContentBackward",
  }));
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
      clearComposer(el);
      selectAllIn(el);
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
    if (!promptTrackingEnabled || !onTrackableSurface()) return;
    if (e.key === "Enter" && !e.shiftKey && lastText.trim().length > 5) {
      trackPrompt(lastText);
      lastText = "";
    }
  }, true);

  document.addEventListener("click", (e) => {
    if (!promptTrackingEnabled || !onTrackableSurface()) return;
    const btn = e.target.closest("button");
    if (
      btn &&
      !btn.classList.contains("pm-trigger") &&
      !btn.closest("#pm-panel") &&
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
  if (voiceState === "recording") return stopVoice();
  if (voiceState === "idle") return startVoice();
  if (voiceState === "reviewing") return cancelVoice();
}

async function startVoice() {
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
      document.getElementById("pm-panel")?.getAttribute("data-pm-theme") || "dark"
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
    btn.title = recording ? "Stop recording" : "Voice to Prompt (Ctrl+Shift+V)";
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
    document.getElementById("pm-panel"),
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
  els.forEach((el) => el.setAttribute("data-pm-theme", theme));

  const toggleBtn = document.getElementById("pm-theme-toggle");
  if (toggleBtn) toggleBtn.textContent = theme === "dark" ? "☀️" : "🌙";
}

// ══════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════

async function init() {
  const auth = await getAuth();
  if (!auth) {
    console.log("Prompt Memory: not logged in, panel will prompt login.");
  } else if (tokenExpiresWithinDays(auth.token, 2) && !isTokenExpired(auth.token)) {
    tryRefreshToken(auth);
  }

  createTrigger();
  createPanel();
  setupKeyboardShortcut();
  setupPassiveTracking();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTimeout(init, 500));
} else {
  setTimeout(init, 500);
}
