// extension/background.js — MV3 service worker
//
// Two jobs:
//
// 1. KEYBOARD SHORTCUTS. manifest.json declares a "commands" block, and Chrome
//    intercepts a registered command chord at the browser level — it never
//    reaches the page, so the content script's own keydown listener could not
//    see it. Previously there was no service worker at all, so nothing handled
//    chrome.commands.onCommand and the declared shortcuts did nothing on the
//    platforms where Chrome won the race. The handler below closes that gap by
//    forwarding the command to the active tab.
//
// 2. API KEY CUSTODY. The user's own provider key lives here and only here.
//    The content script runs in an isolated world on chatgpt.com, claude.ai and
//    other third-party origins; that is the wrong place for a credential. The
//    content script asks this worker to perform an enhancement and receives
//    only text back — it never learns the key.

import {
  PROVIDERS,
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  streamCompletion,
  completion,
  validateKey,
} from "./lib/providers.js";

const DEFAULT_API_URL = "https://siddhm11-prompt-engine.hf.space";

// ─────────────────────────────────────────────────────────────
// SHORTCUTS
// ─────────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "PM_COMMAND", command });
  } catch {
    // No content script on this tab (not one of our matched sites). Nothing to do.
  }
});

// ─────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────

async function getSettings() {
  // chrome.storage.local, never .sync: sync replicates through the user's
  // Google account to every signed-in browser, which is not somewhere an API
  // key should silently travel.
  const s = await chrome.storage.local.get([
    "byok_provider", "byok_key", "byok_model", "api_url", "token", "user_id",
  ]);
  return {
    provider: s.byok_provider || DEFAULT_PROVIDER,
    key: s.byok_key || "",
    model: s.byok_model || DEFAULT_MODEL,
    apiUrl: s.api_url || DEFAULT_API_URL,
    token: s.token || "",
    userId: s.user_id || "",
  };
}

/** True when a JWT is absent, unparseable, or past its exp. */
function isTokenExpired(token) {
  if (!token) return true;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (!payload?.exp) return true;
    return payload.exp * 1000 <= Date.now();
  } catch {
    // Unparseable is unusable — treat it as expired rather than routing a
    // request at the backend that is guaranteed to come back 401.
    return true;
  }
}

/**
 * Which path an enhancement should take.
 *
 *   backend  — signed in. Full memory features. If the user also has a key it
 *              rides along so their own quota is spent, not the shared one.
 *   direct   — not signed in but has a key. No signup, no server, no memory.
 *   none     — neither. The UI prompts for one or the other.
 *
 * The expiry check matters: this used to return "backend" for any stored
 * token, expired or not. JWTs last 7 days, so a lapsed user who also had a
 * perfectly good API key was routed at the backend anyway, got a 401 on every
 * attempt, and was never offered the direct path that would have worked.
 */
function resolveRoute(settings) {
  if (settings.token && !isTokenExpired(settings.token)) return "backend";
  if (settings.key) return "direct";
  if (settings.token) return "expired";   // signed in once; needs to sign in again
  return "none";
}

// ─────────────────────────────────────────────────────────────
// MESSAGE HANDLING
// ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own surfaces may talk to this worker. A message whose sender has
  // no extension id is not from our content script or popup.
  if (sender.id !== chrome.runtime.id) return false;

  (async () => {
    try {
      switch (msg?.type) {
        case "PM_GET_ROUTE": {
          const settings = await getSettings();
          const provider = PROVIDERS[settings.provider];
          const expired = Boolean(settings.token) && isTokenExpired(settings.token);
          sendResponse({
            route: resolveRoute(settings),
            hasKey: Boolean(settings.key),
            signedIn: Boolean(settings.token) && !expired,
            tokenExpired: expired,
            provider: settings.provider,
            providerLabel: provider?.label || settings.provider,
            model: settings.model,
          });
          break;
        }

        // A content script has no API for opening the action popup, which is
        // why five separate "open the settings" messages were dead ends that
        // only told the user to go and click the toolbar icon themselves.
        case "PM_OPEN_OPTIONS": {
          await chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        }

        case "PM_START_GOOGLE_AUTH": {
          sendResponse(await startGoogleAuth(sender));
          break;
        }

        case "PM_VALIDATE_KEY": {
          sendResponse(await validateKey(msg.provider, msg.key));
          break;
        }

        case "PM_ENHANCE_DIRECT": {
          const settings = await getSettings();
          if (!settings.key) {
            sendResponse({ ok: false, error: "No API key set." });
            break;
          }
          const text = await completion({
            providerId: settings.provider,
            apiKey: settings.key,
            modelId: settings.model,
            rawText: msg.prompt,
            mode: msg.mode || "deep",
          });
          if (!text) {
            sendResponse({ ok: false, error: "The model returned an empty response." });
            break;
          }
          sendResponse({
            ok: true, enhanced: text, model: settings.model,
            provider: settings.provider, direct: true,
          });
          break;
        }

        // The credential the content script must never see, handed to the
        // backend so a signed-in user still gets memory features while
        // spending their own quota.
        case "PM_GET_BYOK_FOR_BACKEND": {
          const settings = await getSettings();
          sendResponse(
            settings.key
              ? { provider: settings.provider, key: settings.key, model: settings.model }
              : {}
          );
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;   // keeps the port open for the async sendResponse above
});

// ─────────────────────────────────────────────────────────────
// GOOGLE SIGN-IN
// ─────────────────────────────────────────────────────────────
//
// This lives in the service worker, not the popup, and that placement is the
// whole fix.
//
// An MV3 action popup is destroyed as soon as it loses focus. The old flow ran
// `window.open(...)` from inside the popup and then waited for a postMessage
// on the popup's own window — but opening that window took focus, which killed
// the popup and its listener before Google ever redirected back. Sign-in from
// the toolbar icon could therefore never complete, which is the only route
// offered to a returning user. Polling from the popup would die the same way.
//
// The worker outlives the popup, so it opens the tab, waits for the result,
// and writes it to storage. Whether the popup is open, closed, or reopened
// halfway through makes no difference.

const AUTH_POLL_INTERVAL_MS = 1500;
const AUTH_POLL_TIMEOUT_MS = 4 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Put the user back where they were once sign-in finishes.
 *
 * Only ever called after WE closed the auth tab. When the user closes it
 * themselves they have already chosen where to look, and yanking focus back
 * would override a deliberate action.
 */
async function restoreOriginTab(origin) {
  if (!origin || origin.id === undefined) return;
  // The tab is free to disappear while Google is loading. A failure here must
  // not turn a sign-in that actually succeeded into an error.
  try {
    await chrome.tabs.update(origin.id, { active: true });
    if (origin.windowId !== undefined) {
      await chrome.windows.update(origin.windowId, { focused: true });
    }
  } catch {
    /* the tab or its window went away; leave focus wherever it landed */
  }
}

async function startGoogleAuth(sender) {
  const { apiUrl } = await getSettings();

  // Where to put the user back afterwards.
  //
  // Nothing recorded this before. The auth tab was created from a bare { url }
  // and removed again, with nothing activated in its place, so Chrome was left
  // to pick whatever got focus next — which is why signing in dropped people on
  // an unrelated page. It was never a redirect to the wrong place; it was the
  // absence of one.
  //
  // sender.tab is set when the request came from the options page, which opens
  // in a tab of its own. It is undefined for the toolbar popup, where the tab
  // the user is actually looking at is the active one behind the popup.
  const origin =
    sender?.tab ||
    (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];

  let url, state;
  try {
    const res = await fetch(`${apiUrl}/auth/google/login`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ({ url, state } = await res.json());
  } catch (err) {
    return { ok: false, error: "Could not reach the sign-in server. Try again." };
  }
  if (!url || !state) {
    return { ok: false, error: "Sign-in server returned an unexpected response." };
  }

  // Opened next to where the user was and owned by it, so the tab strip reads
  // as a detour from that page rather than an unrelated tab appended at the end.
  // openerTabId requires the opener to be in the same window, hence windowId.
  const tab = await chrome.tabs.create({
    url,
    ...(origin?.id !== undefined
      ? { openerTabId: origin.id, index: origin.index + 1, windowId: origin.windowId }
      : {}),
  });
  const deadline = Date.now() + AUTH_POLL_TIMEOUT_MS;

  const collect = async () => {
    try {
      const res = await fetch(
        `${apiUrl}/auth/google/poll?state=${encodeURIComponent(state)}`
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data?.status === "ready" && data.token ? data : null;
    } catch {
      return null;   // transient; the caller keeps waiting
    }
  };

  const finish = async (data) => {
    await chrome.storage.local.set({
      token: data.token,
      email: data.email,
      user_id: data.user_id,
    });
    if (tab.id !== undefined) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
    // Explicitly, not by relying on the close. Chrome only *usually* falls back
    // to the opener, and "usually" is precisely what made this feel random.
    await restoreOriginTab(origin);
    return { ok: true, email: data.email };
  };

  while (Date.now() < deadline) {
    await sleep(AUTH_POLL_INTERVAL_MS);

    // Poll BEFORE judging the tab. The token is handed over exactly once, and
    // the callback tab can legitimately be gone by the time we look — the user
    // closes it themselves the moment they see "Signed in". Checking the tab
    // first would report a cancellation for a sign-in that had in fact
    // succeeded, and the token would already have been consumed.
    const data = await collect();
    if (data) return finish(data);

    if (tab.id !== undefined) {
      const stillOpen = await chrome.tabs.get(tab.id).catch(() => null);
      if (!stillOpen) {
        // One last look: the result may have landed in the moment between the
        // poll above and the tab closing.
        const late = await collect();
        if (late) return finish(late);
        return { ok: false, error: "Sign-in was cancelled." };
      }
    }
  }

  return { ok: false, error: "Sign-in timed out. Please try again." };
}

// ─────────────────────────────────────────────────────────────
// STREAMING
// ─────────────────────────────────────────────────────────────
//
// Streamed tokens go over a long-lived port rather than sendMessage, so the
// content script can paint text as it arrives instead of waiting for the whole
// completion. A one-shot sendMessage cannot deliver progressive chunks.

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "pm-stream") return;
  if (port.sender?.id !== chrome.runtime.id) return;

  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "PM_ENHANCE_STREAM") return;
    try {
      const settings = await getSettings();
      if (!settings.key) {
        port.postMessage({ type: "error", error: "No API key set." });
        return;
      }
      const full = await streamCompletion({
        providerId: settings.provider,
        apiKey: settings.key,
        modelId: settings.model,
        rawText: msg.prompt,
        mode: msg.mode || "deep",
        signal: controller.signal,
        onToken: (token) => {
          try {
            port.postMessage({ type: "token", token });
          } catch {
            // Port closed mid-stream — the user dismissed the panel.
            controller.abort();
          }
        },
      });

      if (!full) {
        port.postMessage({ type: "error", error: "The model returned an empty response." });
        return;
      }
      port.postMessage({
        type: "done", enhanced: full,
        model: settings.model, provider: settings.provider, direct: true,
      });
    } catch (err) {
      if (err?.name === "AbortError") return;
      port.postMessage({ type: "error", error: err?.message || String(err) });
    }
  });
});

// ─────────────────────────────────────────────────────────────
// FIRST RUN
// ─────────────────────────────────────────────────────────────

// Sites the content script is declared for. Kept in sync with the
// content_scripts.matches block in manifest.json.
const SUPPORTED_MATCHES = [
  "https://chatgpt.com/*",
  "https://gemini.google.com/*",
  "https://claude.ai/*",
  "https://www.perplexity.ai/*",
  "https://grok.com/*",
  "https://x.com/i/grok*",
];

/**
 * Inject into tabs that were already open.
 *
 * Chrome only runs a declared content script on navigations that happen after
 * the extension loads. Someone who installs this while sitting on a ChatGPT
 * tab — the overwhelmingly likely case, since that is where they were when
 * they went looking for it — got nothing at all, with no error, until they
 * happened to reload. They have no way to know a reload is what is missing.
 */
async function activateExistingTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: SUPPORTED_MATCHES });
  } catch {
    return;   // host permissions declined; the declarative script still works
  }
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["styles.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch {
      // Chrome Web Store pages, pre-render tabs and discarded tabs all reject
      // injection. Nothing to do for those.
    }
  }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "update") {
    // An update orphans the content script in every open tab: the old script
    // keeps running against a worker that no longer exists.
    await activateExistingTabs();
    return;
  }
  if (reason !== "install") return;

  await activateExistingTabs();

  // Open settings on install so the first thing a new user sees is the one
  // action that makes the extension work, rather than discovering on their
  // first Ctrl+Shift+E that they need an account.
  chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?onboarding=1") });
});
