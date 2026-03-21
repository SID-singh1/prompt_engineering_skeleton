// extension/content.js — Prompt Memory v4
// One-click prompt engineering. Conversation-aware. Mode-aware. Platform-aware.
// Streaming enhancement. History. Token auto-refresh. Multi-language voice.

// Default API URL — overridden by chrome.storage.local['api_url'] (set via popup)
// const DEFAULT_API_URL = "https://siddhm11-prompt-engine.hf.space";  // ← production
const DEFAULT_API_URL = "http://localhost:8000";  // ← local testing
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
let enhanceHistory = [];
let usageData = { count: 0, limit: 30 };
let isLoadingTab = false;

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

async function createSavedPrompt(content, title, tags) {
  const body = { content };
  if (title && title.trim()) body.title = title.trim();
  if (tags && tags.length > 0) body.tags = tags;
  const res = await authedFetch(`${API_URL}/saved-prompts`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (res && res.ok) {
    const data = await res.json();
    if (data.duplicate) {
      showToast("This prompt is already saved.", "info");
    }
    return true;
  }
  return false;
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

async function enhancePromptStream(prompt, selectedPromptIds, onToken, onDone) {
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

  try {
    const res = await fetch(`${API_URL}/enhance/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify(body),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
              onDone(data);
            } else if (data.error) {
              console.error("Stream error:", data.error);
            }
          } catch (e) { }
        }
      }
    }
  } catch (e) {
    console.error("Streaming enhance error:", e);
    return null;
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
      document.querySelectorAll("message-content, .model-response-text, .query-text").forEach((el) => {
        const text = el.innerText?.trim();
        if (text && text.length > 2) {
          messages.push(`[message]: ${text.substring(0, 500)}`);
        }
      });
    } else if (hostname === "grok.com" || hostname === "x.com") {
      document.querySelectorAll("[class*='message'], [class*='Message'], [data-testid*='message'], [class*='response'], [class*='query']").forEach((el) => {
        const text = el.innerText?.trim();
        if (text && text.length > 2) {
          messages.push(`[message]: ${text.substring(0, 500)}`);
        }
      });
    } else {
      document.querySelectorAll("[class*='message'], [class*='Message'], [role='presentation']").forEach((el) => {
        const text = el.innerText?.trim();
        if (text && text.length > 5 && text.length < 2000) {
          messages.push(text.substring(0, 500));
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
  btn.title = "Prompt Memory (Ctrl+Shift+E to enhance)";
  btn.addEventListener("click", () => togglePanel());
  document.body.appendChild(btn);

  // Apply saved theme to trigger
  chrome.storage.local.get("pm_theme", (result) => {
    btn.setAttribute("data-pm-theme", result.pm_theme || "dark");
  });
}

// ══════════════════════════════════════════════════════════════
// KEYBOARD SHORTCUT: Ctrl+Shift+E = Instant Enhance
// ══════════════════════════════════════════════════════════════

function setupKeyboardShortcut() {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "E") {
      e.preventDefault();
      handleEnhance();
    }
    if (e.ctrlKey && e.shiftKey && e.key === "V") {
      e.preventDefault();
      toggleVoice();
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
      <button class="pm-theme-toggle" id="pm-theme-toggle" title="Toggle light/dark mode">🌙</button>
      <button class="pm-header-close" id="pm-close">×</button>
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
    const res = await authedFetch(`${API_URL}/enhance/usage`);
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
  label.textContent = `${usageData.count}/${usageData.limit} today`;
}

// ══════════════════════════════════════════════════════════════
// RENDER: TAB CONTENT
// ══════════════════════════════════════════════════════════════

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

    const ok = await createSavedPrompt(content, title, tags);
    if (ok) {
      setStatus("pm-save-status", "Prompt saved successfully.", "success");
      document.getElementById("pm-save-content").value = "";
      document.getElementById("pm-save-title").value = "";
      document.getElementById("pm-save-tags").value = "";
      await fetchSavedPrompts();
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
        applyToInput(item.enhanced);
        showToast("Prompt applied to input!", "success");
      });

      card.querySelector(".pm-history-copy").addEventListener("click", () => {
        navigator.clipboard.writeText(item.enhanced);
        showToast("Copied to clipboard!", "success");
      });

      container.appendChild(card);
    });
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
  });
}

// ══════════════════════════════════════════════════════════════
// ENHANCE HANDLER (streaming)
// ══════════════════════════════════════════════════════════════

async function handleEnhance() {
  const auth = await getAuth();
  if (!auth) {
    showToast("Please log in first (click the extension icon).", "error");
    return;
  }
  if (isTokenExpired(auth.token)) {
    showToast("Session expired — re-login from extension popup.", "error");
    return;
  }

  const inputText = getCurrentInputText();
  if (!inputText || inputText.trim().length < 3) {
    showToast("Type a prompt in the chat input first.", "error");
    return;
  }

  const btn = document.getElementById("pm-enhance-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Enhancing...";
  }
  showToast(`Enhancing in ${currentMode} mode...`, "info");

  // Use streaming enhancement
  showStreamingDiffModal(inputText);

  let enhancedParts = [];

  await enhancePromptStream(
    inputText,
    Array.from(selectedIds),
    // onToken
    (token) => {
      enhancedParts.push(token);
      updateStreamingText(enhancedParts.join(""));
    },
    // onDone
    (metadata) => {
      const enhanced = enhancedParts.join("");
      lastEnhanceResult = {
        original: inputText,
        enhanced: enhanced,
        log_id: metadata.log_id,
        latency: metadata.latency,
        mode: metadata.mode,
        context_used: metadata.context_used,
      };
      finalizeStreamingModal(lastEnhanceResult);
      // Increment local usage counter
      usageData.count++;
      updateUsageBar();
    }
  );

  if (btn) {
    btn.disabled = false;
    btn.textContent = "Enhance Current Prompt";
  }
}

// ══════════════════════════════════════════════════════════════
// STREAMING DIFF MODAL — Shows tokens arriving in real-time
// ══════════════════════════════════════════════════════════════

function showStreamingDiffModal(originalText) {
  const overlay = getOrCreateModalOverlay();
  const modal = overlay.querySelector(".pm-modal");

  modal.innerHTML = `
    <div class="pm-modal-header">
      <span class="pm-modal-title">Enhancing...</span>
      <button class="pm-header-close pm-modal-close-btn">×</button>
    </div>
    <div class="pm-modal-body pm-diff-body">
      <div class="pm-diff-section" id="pm-diff-original-section">
        <div class="pm-diff-label-row">
          <div class="pm-diff-label">Original</div>
        </div>
        <div class="pm-diff-original">${escHtml(originalText)}</div>
      </div>
      <div class="pm-diff-arrow">↓ enhancing in ${currentMode} mode...</div>
      <div class="pm-diff-section">
        <div class="pm-diff-label pm-diff-label-new">Enhanced</div>
        <div class="pm-diff-enhanced pm-streaming" id="pm-stream-target"><span class="pm-cursor">▊</span></div>
      </div>
    </div>
    <div class="pm-modal-footer">
      <button class="pm-btn pm-btn-secondary pm-modal-close-btn">Cancel</button>
    </div>
  `;

  overlay.querySelectorAll(".pm-modal-close-btn").forEach((b) =>
    b.addEventListener("click", closeModal)
  );

  overlay.classList.add("pm-visible");
}

function updateStreamingText(text) {
  const target = document.getElementById("pm-stream-target");
  if (target) {
    target.innerHTML = escHtml(text) + '<span class="pm-cursor">▊</span>';
  }
}

function finalizeStreamingModal(result) {
  // Re-render as the full diff modal with all buttons
  showDiffModal(result);
}

// ══════════════════════════════════════════════════════════════
// DIFF PREVIEW MODAL — Shows original vs enhanced
// ══════════════════════════════════════════════════════════════

function showDiffModal(result) {
  const overlay = getOrCreateModalOverlay();
  const modal = overlay.querySelector(".pm-modal");

  const contextLine = result.context_used
    ? `${result.context_used.selected} selected · ${result.context_used.auto_matched} auto-matched · ${result.context_used.passive_matched || 0} from history · ${result.context_used.conversation_messages} conversation msgs`
    : "";

  modal.innerHTML = `
    <div class="pm-modal-header">
      <span class="pm-modal-title">Enhanced Prompt</span>
      <button class="pm-header-close pm-modal-close-btn">×</button>
    </div>
    <div class="pm-modal-body pm-diff-body">
      <div class="pm-diff-section" id="pm-diff-original-section">
        <div class="pm-diff-label-row">
          <div class="pm-diff-label">Original</div>
          <button class="pm-diff-edit-btn" id="pm-edit-original-btn">
            <span class="pm-edit-icon">✏️</span>
            <span class="pm-edit-text">Edit</span>
          </button>
        </div>
        <div class="pm-diff-original" id="pm-diff-original-text">${escHtml(result.original)}</div>
      </div>
      <div class="pm-diff-arrow" id="pm-diff-arrow">↓ enhanced in ${result.mode || currentMode} mode</div>
      <div class="pm-diff-section" id="pm-diff-enhanced-section">
        <div class="pm-diff-label pm-diff-label-new">Enhanced</div>
        <div class="pm-diff-enhanced">${escHtml(result.enhanced)}</div>
      </div>
      ${contextLine ? `<div class="pm-diff-meta">${escHtml(contextLine)} · ${result.latency}s</div>` : ""}
    </div>
    <div class="pm-modal-footer">
      <button class="pm-btn pm-btn-secondary pm-modal-close-btn">Discard</button>
      <button class="pm-btn pm-btn-secondary" id="pm-copy-enhanced">Copy</button>
      <button class="pm-btn pm-btn-secondary" id="pm-save-enhanced">Save</button>
      <button class="pm-btn pm-btn-primary" id="pm-use-enhanced">Use This Prompt</button>
    </div>
  `;

  overlay.querySelectorAll(".pm-modal-close-btn").forEach((b) =>
    b.addEventListener("click", closeModal)
  );

  // Edit original prompt
  document.getElementById("pm-edit-original-btn").addEventListener("click", () => {
    const section = document.getElementById("pm-diff-original-section");
    const originalTextEl = document.getElementById("pm-diff-original-text");
    const editBtn = document.getElementById("pm-edit-original-btn");

    editBtn.style.display = "none";
    const label = section.querySelector(".pm-diff-label");
    if (label) label.textContent = "Original (editing)";

    originalTextEl.outerHTML = `
      <textarea class="pm-diff-edit-textarea" id="pm-diff-edit-textarea">${escHtml(result.original)}</textarea>
      <div class="pm-diff-edit-actions">
        <button class="pm-cancel-edit-btn" id="pm-cancel-edit">Cancel</button>
        <button class="pm-reenhance-btn" id="pm-reenhance-btn">Re-Enhance ↻</button>
      </div>
    `;

    const textarea = document.getElementById("pm-diff-edit-textarea");
    if (textarea) {
      textarea.focus();
      textarea.selectionStart = textarea.value.length;
    }

    document.getElementById("pm-cancel-edit").addEventListener("click", () => {
      showDiffModal(result);
    });

    document.getElementById("pm-reenhance-btn").addEventListener("click", () => {
      const editedText = document.getElementById("pm-diff-edit-textarea").value.trim();
      handleReEnhance(editedText, result.original);
    });
  });

  // Copy enhanced prompt
  document.getElementById("pm-copy-enhanced").addEventListener("click", () => {
    navigator.clipboard.writeText(result.enhanced);
    showToast("Copied to clipboard!", "success");
  });

  // Use enhanced prompt
  document.getElementById("pm-use-enhanced").addEventListener("click", () => {
    applyToInput(result.enhanced);
    closeModal();
    showFeedbackToast(result);
  });

  // Save enhanced prompt
  document.getElementById("pm-save-enhanced").addEventListener("click", async () => {
    const ok = await createSavedPrompt(result.enhanced, null, []);
    if (ok) {
      showToast("Enhanced prompt saved!", "success");
      await fetchSavedPrompts();
    }
    closeModal();
  });

  overlay.classList.add("pm-visible");
}

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

function showFeedbackToast(result) {
  const existing = document.getElementById("pm-feedback-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "pm-feedback-toast";
  toast.className = "pm-feedback-toast";
  toast.innerHTML = `
    <span>How was this enhancement?</span>
    <button class="pm-fb-btn pm-fb-up" title="Good">👍</button>
    <button class="pm-fb-btn pm-fb-down" title="Bad">👎</button>
  `;

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("pm-toast-visible"));

  const autoDismiss = setTimeout(() => {
    toast.classList.remove("pm-toast-visible");
    setTimeout(() => toast.remove(), 300);
  }, 8000);

  toast.querySelector(".pm-fb-up").addEventListener("click", () => {
    clearTimeout(autoDismiss);
    sendFeedback(result.log_id, "up", result.original, result.enhanced);
    toast.innerHTML = `<span>Thanks! 🎯</span>`;
    setTimeout(() => { toast.classList.remove("pm-toast-visible"); setTimeout(() => toast.remove(), 300); }, 1500);
  });

  toast.querySelector(".pm-fb-down").addEventListener("click", () => {
    clearTimeout(autoDismiss);
    sendFeedback(result.log_id, "down", result.original, result.enhanced);
    toast.innerHTML = `<span>Got it — we'll improve. 🙏</span>`;
    setTimeout(() => { toast.classList.remove("pm-toast-visible"); setTimeout(() => toast.remove(), 300); }, 1500);
  });
}

function showToast(message, type = "info") {
  const existing = document.getElementById("pm-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "pm-toast";
  toast.className = `pm-toast pm-toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("pm-toast-visible"));

  setTimeout(() => {
    toast.classList.remove("pm-toast-visible");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
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

function getCurrentInputText() {
  const selectors = [
    "#prompt-textarea",
    "[contenteditable='true']",
    "textarea",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      return el.innerText || el.value || "";
    }
  }
  return "";
}

function applyToInput(text) {
  const selectors = [
    "#prompt-textarea",
    "[contenteditable='true']",
    "textarea",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.offsetParent !== null) {
      if (el.tagName === "TEXTAREA") {
        el.value = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        el.innerText = text;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return;
    }
  }
}

function setupPassiveTracking() {
  let lastText = "";

  document.addEventListener("input", (e) => {
    const el = e.target;
    if (
      el.matches("#prompt-textarea, [contenteditable='true'], textarea") &&
      el.offsetParent !== null
    ) {
      lastText = el.innerText || el.value || "";
    }
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && lastText.trim().length > 5) {
      trackPrompt(lastText);
      lastText = "";
    }
  }, true);

  document.addEventListener("click", (e) => {
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

let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = 0;
let recordingTimer = null;

function toggleVoice() {
  if (isRecording) {
    stopVoice();
  } else {
    startVoice();
  }
}

async function startVoice() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showToast("Microphone access denied. Allow it in browser settings.", "error");
    return;
  }

  audioChunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(recordingTimer);

    if (audioChunks.length === 0) {
      cleanupVoice();
      showToast("No audio recorded.", "error");
      return;
    }

    const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
    audioChunks = [];

    updateVoiceOverlayState("processing");
    await sendAudioToBackend(audioBlob);
  };

  mediaRecorder.start(250);
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

  showToast("🎤 Recording... speak your prompt", "info");
}

function stopVoice() {
  if (!mediaRecorder || mediaRecorder.state === "inactive") return;
  isRecording = false;
  updateVoiceUI(false);
  try {
    mediaRecorder.stop();
  } catch (e) { }
}

async function sendAudioToBackend(audioBlob) {
  const auth = await getAuth();
  if (!auth || isTokenExpired(auth.token)) {
    hideVoiceOverlay();
    showToast("Please log in first.", "error");
    return;
  }

  const conversationCtx = scrapeConversation();

  const formData = new FormData();
  formData.append("audio", audioBlob, "recording.webm");
  formData.append("mode", currentMode);
  formData.append("platform", window.location.hostname);
  formData.append("conversation_context", JSON.stringify(conversationCtx));
  formData.append("selected_prompt_ids", JSON.stringify(Array.from(selectedIds)));

  try {
    const resp = await fetch(`${API_URL}/voice-enhance`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.token}` },
      body: formData,
    });
    const data = await resp.json();

    hideVoiceOverlay();

    if (data.error) {
      showToast(data.error, "error");
      return;
    }

    const langLabel = data.detected_language && data.detected_language !== "unknown"
      ? ` · Language: ${data.detected_language}`
      : "";

    lastEnhanceResult = {
      original: data.transcription || data.original,
      enhanced: data.enhanced,
      mode: data.mode,
      latency: data.total_time,
      context_used: data.context_used,
      log_id: data.log_id,
    };

    showToast(`Transcribed in ${data.transcription_time}s · Enhanced in ${data.total_time}s${langLabel}`, "success");
    showDiffModal(lastEnhanceResult);
  } catch (e) {
    hideVoiceOverlay();
    console.error("Voice enhance error:", e);
    showToast("Voice enhance failed. Check connection.", "error");
  }
}

function cleanupVoice() {
  isRecording = false;
  mediaRecorder = null;
  audioChunks = [];
  clearInterval(recordingTimer);
  updateVoiceUI(false);
  hideVoiceOverlay();
}

// ── Voice UI: Recording Overlay ──

function showVoiceOverlay() {
  let overlay = document.getElementById("pm-voice-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "pm-voice-overlay";
    overlay.className = "pm-voice-overlay";
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
      <div class="pm-voice-hint">Speak naturally — Whisper AI will transcribe & auto-detect language</div>
      <button class="pm-btn pm-btn-primary pm-voice-stop" id="pm-voice-stop">Stop & Enhance</button>
    </div>
  `;

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) stopVoice();
  });
  document.getElementById("pm-voice-stop").addEventListener("click", stopVoice);

  requestAnimationFrame(() => overlay.classList.add("pm-visible"));
}

function updateVoiceOverlayState(state) {
  const card = document.querySelector(".pm-voice-card");
  if (!card) return;

  if (state === "processing") {
    card.innerHTML = `
      <div class="pm-voice-indicator">
        <div class="pm-voice-spinner"></div>
        <span class="pm-voice-label">Transcribing & enhancing...</span>
      </div>
      <div class="pm-voice-hint">Whisper AI is processing your audio</div>
    `;
  }
}

function hideVoiceOverlay() {
  const overlay = document.getElementById("pm-voice-overlay");
  if (overlay) {
    overlay.classList.remove("pm-visible");
    setTimeout(() => overlay.remove(), 300);
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