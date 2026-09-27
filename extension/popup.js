// ════════════════════════════════════════════════════════════════
// Prompt Memory — the toolbar popup, the install tab and the options page
// ════════════════════════════════════════════════════════════════
//
// One page with three screens, picked by render() from what is in storage:
//
//   welcome  no consent yet: what it does, what is sent, Agree and continue
//   setup    consented, but nothing to rewrite with: Google, or your own key
//   ready    signed in and/or a key: how to use it now, then the settings
//
// It used to be a consent wall, then a login card with a hidden key form under
// an "or", and nothing after setup said what to do next: people finished
// setting up and did not know the plus button existed.

const DEFAULT_API_URL = "https://siddhm11-prompt-engine.hf.space";  // ← production
// const DEFAULT_API_URL = "http://localhost:8000";  // ← local testing
const API_URL = DEFAULT_API_URL;
const DATA_CONSENT_KEY = "pm_data_consent_v1";

// The header shows the manifest's version rather than a number typed into the
// HTML, which stayed at 4.4 while the extension itself moved on.
try {
    document.getElementById("popup-version").textContent = "v" + chrome.runtime.getManifest().version;
} catch { /* the static label stands */ }

// Rendered in a full browser tab (post-install page, or the options page)
// rather than the toolbar strip — let it use the width it has.
if (location.search.includes("onboarding") || window.innerWidth > 420) {
    document.body.classList.add("pm-standalone");
}

const $ = (id) => document.getElementById(id);
const state = { consent: false, email: "", token: "", key: null, tipsOff: false, tipsSeen: 0, rewrites: 0 };

// ════════════════════════════════════════════════════════════════
// RENDER
// ════════════════════════════════════════════════════════════════

function screenFor(s) {
    if (!s.consent) return "welcome";
    if (!s.token && !s.key) return "setup";
    return "ready";
}

function render() {
    const screen = screenFor(state);
    for (const name of ["welcome", "setup", "ready"]) $(`screen-${name}`).hidden = name !== screen;

    const head = $("head-state");
    head.hidden = screen === "welcome";
    head.className = `head-state ${screen === "ready" ? "on" : "off"}`;
    $("head-state-text").textContent = screen === "ready" ? "Ready" : "Setup needed";

    if (screen === "ready") renderReady();
    renderPinHint(screen);
    // Deep link from the chat page ("Add my key"): open the key form once.
    if (location.hash === "#key" && !deepLinked && screen !== "welcome") {
        deepLinked = true;
        openKeyForm(screen);
    }
}
let deepLinked = false;

function notice(text) {
    const el = $("notice");
    el.textContent = text;
    el.hidden = !text;
    clearTimeout(notice.timer);
    notice.timer = setTimeout(() => { el.hidden = true; }, 6000);
}

// Only when the icon really is hidden, and not over the welcome screen,
// which has one job. getUserSettings() is Chrome 91+; older builds skip it.
function renderPinHint(screen) {
    const el = $("pin-hint");
    if (screen === "welcome" || !chrome.action?.getUserSettings) { el.hidden = true; return; }
    chrome.action.getUserSettings().then((s) => { el.hidden = Boolean(s?.isOnToolbar); }, () => { el.hidden = true; });
}

function renderReady() {
    // Before the first rewrite this card is the whole point of the page. After
    // it, the steps are known; the chat links and the shortcut stay.
    const fresh = state.rewrites === 0;
    $("ready-heading").textContent = fresh ? "You're ready. Try it now:" : "Use it in any of these chats";
    $("ready-card").querySelector(".steps").hidden = !fresh;

    const signedIn = Boolean(state.token && state.email);
    $("acct-in").hidden = !signedIn;
    $("acct-out").hidden = signedIn;
    $("danger-wrap").hidden = !signedIn;
    if (signedIn) {
        $("user-display").textContent = state.email;
        $("profile-avatar").textContent = state.email.charAt(0).toUpperCase();
    }

    const k = state.key;
    $("key-icon").classList.toggle("on", Boolean(k));
    $("key-title").textContent = k ? `${providerLabel(k.provider)} key connected` : "Your own key";
    $("key-sub").textContent = k
        ? `Ends in ${k.last4} · ${signedIn ? "used instead of the shared allowance" : "your provider's free limits"}`
        : signedIn ? "Optional · use your own provider instead of 15 a day" : "Optional";
    $("key-manage").textContent = $("key-panel-slot").hidden ? (k ? "Change" : "Add") : "Close";

    $("tips-toggle").checked = !state.tipsOff;
    $("tips-reset-row").hidden = state.tipsOff || state.tipsSeen === 0;
}

function load() {
    chrome.storage.local.get(
        [DATA_CONSENT_KEY, "email", "token", "user_id", "byok_provider", "byok_key", "byok_model", "pm_tips_off", "pm_tips", "pm_stats"],
        (r) => {
            state.consent = r[DATA_CONSENT_KEY] === true;
            state.email = r.email || "";
            state.token = r.token && r.user_id ? r.token : "";
            state.key = r.byok_key
                ? { provider: r.byok_provider || "groq", model: r.byok_model || "", last4: r.byok_key.slice(-4) }
                : null;
            state.tipsOff = r.pm_tips_off === true;
            state.tipsSeen = Object.keys(r.pm_tips || {}).length;
            state.rewrites = (r.pm_stats && r.pm_stats.rewrites) || 0;
            render();
        });
}

// ════════════════════════════════════════════════════════════════
// WELCOME
// ════════════════════════════════════════════════════════════════

$("pm-consent-agree").addEventListener("click", () => {
    chrome.storage.local.set({ [DATA_CONSENT_KEY]: true }, () => {
        state.consent = true;
        refreshSession();
        render();
    });
});

// ════════════════════════════════════════════════════════════════
// ACCOUNT
// ════════════════════════════════════════════════════════════════

// Refresh only after the user has accepted the data disclosure.
async function refreshSession() {
    if (!state.consent) return;
    const r = await chrome.storage.local.get(["user_id", "email", "token"]);
    if (r.user_id && r.email && r.token && isTokenExpiringSoon(r.token, 2)) {
        await tryRefreshToken(r.token);
    }
}

function isTokenExpiringSoon(token, days = 2) {
    try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        return payload.exp * 1000 < Date.now() + days * 24 * 60 * 60 * 1000;
    } catch {
        return false;
    }
}

async function tryRefreshToken(token) {
    try {
        const res = await fetch(`${API_URL}/auth/refresh`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
        });
        if (res.ok) {
            const data = await res.json();
            chrome.storage.local.set({ token: data.token, email: data.email, user_id: data.user_id });
            return true;
        }
    } catch (e) {
        console.log("Popup: token refresh failed", e);
    }
    return false;
}

// The flow is owned by the service worker, and it has to be: opening Google's
// page moves focus, and Chrome destroys an action popup the moment it loses
// focus, so a listener here would be gone before Google redirected back. The
// worker opens the tab and collects the result; the storage listener below
// updates this page if it is still open.
function startGoogleSignIn(button) {
    const status = $("status");
    button.disabled = true;
    status.className = "status busy";
    status.textContent = "Waiting for Google sign-in in the new tab…";
    chrome.runtime.sendMessage({ type: "PM_START_GOOGLE_AUTH" }, (res) => {
        button.disabled = false;
        // Expected whenever the popup closed while signing in: the worker still
        // completes the flow and writes the token.
        if (chrome.runtime.lastError) return;
        if (res?.ok) {
            status.textContent = "";
        } else {
            status.className = "status err";
            status.textContent = res?.error || "Sign-in failed. Try again.";
        }
    });
}
$("google-login-btn").addEventListener("click", (e) => startGoogleSignIn(e.currentTarget));
$("acct-signin").addEventListener("click", (e) => startGoogleSignIn(e.currentTarget));

// Reflect a sign-in (or anything else) that changed while this page was open.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const watched = ["token", "email", "user_id", "byok_key", "byok_provider", "pm_tips", "pm_tips_off", "pm_stats", DATA_CONSENT_KEY];
    if (watched.some((k) => k in changes)) load();
});

$("logout-btn").addEventListener("click", () => {
    chrome.storage.local.remove(["user_id", "email", "token"]);
});

$("delete-account-confirm").addEventListener("click", async () => {
    const input = $("delete-account-input");
    const status = $("delete-account-status");
    if (input.value.trim() !== "DELETE") {
        status.textContent = "Type DELETE to confirm.";
        return;
    }
    const button = $("delete-account-confirm");
    button.disabled = true;
    status.className = "status busy";
    status.textContent = "Deleting your account and saved data…";
    try {
        let { token } = await chrome.storage.local.get("token");
        if (!token) throw new Error("Please sign in again before deleting your account.");
        if (isTokenExpiringSoon(token, 2)) {
            const refreshed = await tryRefreshToken(token);
            if (refreshed) ({ token } = await chrome.storage.local.get("token"));
        }
        const response = await fetch(`${API_URL}/users/me`, {
            method: "DELETE", headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
            if (response.status === 401) throw new Error("Session expired. Sign in again, then retry deletion.");
            throw new Error("Deletion is incomplete. Please retry; your account remains available.");
        }
        await chrome.storage.local.remove(["user_id", "email", "token", "pm_draft"]);
        try { await chrome.storage.session?.remove("pm_draft"); } catch { /* server deletion succeeded */ }
        input.value = "";
        status.textContent = "";
        notice("Your account and its data were deleted from our servers.");
    } catch (error) {
        status.className = "status err";
        status.textContent = error.message || "Could not delete the account. Please retry.";
    } finally {
        button.disabled = false;
    }
});

// ════════════════════════════════════════════════════════════════
// YOUR OWN KEY
// ════════════════════════════════════════════════════════════════
//
// Kept in chrome.storage.local, deliberately NOT chrome.storage.sync: sync
// replicates through the user's Google account to every browser they are
// signed into, which is not somewhere an API key should travel silently.
// Direct calls stay in the worker; the worker also validates the key.

const PROVIDER_INFO = {
    groq: {
        label: "Groq",
        keysUrl: "https://console.groq.com/keys",
        console: "Open the Groq console ↗",
        placeholder: "gsk_…",
        privacy: "Your prompts go straight from your browser to Groq. Groq does not train on API inputs.",
        models: [
            ["qwen/qwen3.8-27b", "Qwen 3.8 27B — fastest, best Hinglish"],
            ["qwen/qwen3.6-27b", "Qwen 3.6 27B"],
            ["openai/gpt-oss-120b", "GPT-OSS 120B — strongest English"],
            ["openai/gpt-oss-20b", "GPT-OSS 20B"],
        ],
    },
    gemini: {
        label: "Google Gemini",
        keysUrl: "https://aistudio.google.com/apikey",
        console: "Open Google AI Studio ↗",
        placeholder: "AIza…",
        // Stated up front rather than buried: Google's own pricing table marks
        // free-tier data "Used to improve our products: Yes" (paid tier: "No").
        privacy: "Free, but Google may use free-tier prompts to improve their products. Groq does not.",
        models: [
            ["gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite — fastest"],
            ["gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite"],
            ["gemini-3.5-flash", "Gemini 3.5 Flash"],
        ],
    },
    openrouter: {
        label: "OpenRouter",
        keysUrl: "https://openrouter.ai/keys",
        console: "Open OpenRouter keys ↗",
        placeholder: "sk-or-…",
        privacy: "Data policy depends on the upstream provider you route to.",
        models: [["", "Type a model id below"]],
    },
};

const providerLabel = (id) => (PROVIDER_INFO[id] || {}).label || id;

// One key form, moved into whichever screen asks for it.
const keyForm = $("key-form-template").content.firstElementChild.cloneNode(true);
const kf = (id) => keyForm.querySelector(`#${id}`);

function renderProvider(providerId, selectedModel) {
    const info = PROVIDER_INFO[providerId] || PROVIDER_INFO.groq;
    kf("key-get-link").href = info.keysUrl;
    kf("key-get-link").textContent = info.console;
    kf("key-input").placeholder = state.key && state.key.provider === providerId
        ? `Saved — ${"•".repeat(12)}${state.key.last4}` : info.placeholder;
    kf("key-privacy").textContent = info.privacy;
    const models = kf("key-model");
    models.innerHTML = "";
    for (const [id, label] of info.models) {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = label;
        models.appendChild(opt);
    }
    if (selectedModel && info.models.some(([id]) => id === selectedModel)) models.value = selectedModel;
}

function setKeyStatus(text, kind) {
    const el = kf("key-status");
    el.textContent = text || "";
    el.className = `status ${kind || ""}`;
}

function openKeyForm(where) {
    const provider = state.key?.provider || "groq";
    kf("key-provider").value = provider;
    renderProvider(provider, state.key?.model);
    kf("key-clear").hidden = !state.key;
    if (where === "setup") {
        $("key-form-slot").appendChild(keyForm);
        $("key-open").hidden = true;
    } else {
        $("key-panel-slot").appendChild(keyForm);
        $("key-panel-slot").hidden = false;
        $("key-manage").setAttribute("aria-expanded", "true");
        renderReady();
    }
    kf("key-input").focus();
}

function closeKeyPanel() {
    $("key-panel-slot").hidden = true;
    $("key-manage").setAttribute("aria-expanded", "false");
    renderReady();
}

$("key-open").addEventListener("click", () => openKeyForm("setup"));
$("key-manage").addEventListener("click", () => {
    if ($("key-panel-slot").hidden) openKeyForm("ready");
    else closeKeyPanel();
});

kf("key-provider").addEventListener("change", () => {
    renderProvider(kf("key-provider").value);
    setKeyStatus("", "");
});

kf("key-save").addEventListener("click", () => {
    const provider = kf("key-provider").value;
    const key = kf("key-input").value.trim();
    const model = kf("key-model").value;
    if (!key) {
        setKeyStatus("Paste your key first.", "err");
        kf("key-input").focus();
        return;
    }
    const btn = kf("key-save");
    btn.disabled = true;
    setKeyStatus("Testing your key…", "busy");
    chrome.runtime.sendMessage({ type: "PM_VALIDATE_KEY", provider, key }, (res) => {
        btn.disabled = false;
        if (chrome.runtime.lastError || !res) {
            setKeyStatus("Could not reach the extension. Try reloading it in chrome://extensions.", "err");
            return;
        }
        if (!res.ok) {
            setKeyStatus(res.detail || "That key did not work. Check you copied all of it.", "err");
            return;
        }
        chrome.storage.local.set({ byok_provider: provider, byok_key: key, byok_model: model }, () => {
            kf("key-input").value = "";
            setKeyStatus(`${res.detail || "Key works."} Saved on this computer only.`, "ok");
            // The storage listener re-renders; from setup that is the ready screen.
        });
    });
});

kf("key-clear").addEventListener("click", () => {
    chrome.storage.local.remove(["byok_provider", "byok_key", "byok_model"], () => {
        kf("key-input").value = "";
        setKeyStatus("Key removed from this computer.", "");
    });
});

// ════════════════════════════════════════════════════════════════
// TIPS AND SHORTCUTS
// ════════════════════════════════════════════════════════════════

$("tips-toggle").addEventListener("change", (e) => {
    chrome.storage.local.set({ pm_tips_off: !e.target.checked });
});
$("tips-reset").addEventListener("click", () => {
    chrome.storage.local.remove("pm_tips");
});

const openShortcuts = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
$("shortcut-fix").addEventListener("click", openShortcuts);
$("open-shortcuts").addEventListener("click", openShortcuts);

// Show the shortcut Chrome actually assigned. If another extension already had
// Ctrl+Shift+E when this one was installed, Chrome leaves it unset, and the
// shortcut silently does nothing: say so, and link to where it can be set.
chrome.commands.getAll((commands) => {
    if (chrome.runtime.lastError) return;
    const enhance = commands.find((c) => c.name === "enhance-prompt");
    const keys = enhance?.shortcut || "";
    document.querySelectorAll('[data-command="enhance-prompt"], [data-shortcut]').forEach((el) => {
        el.textContent = keys || "Not set";
    });
    $("shortcut-fix").hidden = Boolean(keys);
});

// Deep links from the chat page: #key opens the key form, #signin points at Google.
if (location.hash === "#signin") {
    window.addEventListener("load", () => $("google-login-btn").focus(), { once: true });
}

load();
refreshSession();
