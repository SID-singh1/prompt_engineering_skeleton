const DEFAULT_API_URL = "https://siddhm11-prompt-engine.hf.space";
const params = new URLSearchParams(window.location.search);
const LOCAL_API_URLS = new Set([
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

function apiOrigin() {
  const candidate = params.get("api");
  if (!candidate) return DEFAULT_API_URL;
  try {
    const url = new URL(candidate);
    // The dashboard key is sent in a request header. Never let a query-string
    // parameter redirect that header to an arbitrary HTTPS endpoint.
    if (url.origin === DEFAULT_API_URL || LOCAL_API_URLS.has(url.origin)) {
      return url.origin;
    }
  } catch { /* use the production origin */ }
  return DEFAULT_API_URL;
}

const API_URL = apiOrigin();
// Keep the key in memory only. Reloading the page deliberately requires the
// builder to enter it again rather than leaving a bearer secret in web storage.
const state = { key: "", days: 7 };
const $ = (id) => document.getElementById(id);

function number(value) { return new Intl.NumberFormat().format(value || 0); }
function seconds(value) { return `${Number(value || 0).toFixed(2)}s`; }
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#039;"}[ch]));
}
function setAuthError(message) { $("auth-error").textContent = message || ""; }
function showDashboard() { $("auth-gate").classList.add("hidden"); $("dashboard").classList.remove("hidden"); }
function lockDashboard() {
  state.key = "";
  $("dashboard").classList.add("hidden");
  $("auth-gate").classList.remove("hidden");
  $("builder-key").value = "";
}

async function loadDashboard() {
  $("refresh").disabled = true;
  $("dashboard-error").classList.add("hidden");
  $("dashboard-notice").classList.add("hidden");
  try {
    const response = await fetch(`${API_URL}/builder/dashboard/summary?days=${state.days}`, {
      headers: { "X-Builder-Key": state.key },
      cache: "no-store",
    });
    if (response.status === 404) {
      lockDashboard();
      setAuthError("Builder dashboard is disabled on backend (BUILDER_DASHBOARD_KEY not configured).");
      return;
    }
    if (response.status === 403) {
      lockDashboard();
      setAuthError("Dashboard key was rejected. Incorrect key entered.");
      return;
    }
    if (!response.ok) throw new Error(`Dashboard returned HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    $("dashboard-error").textContent = `${error.message}. Check the backend URL and try again.`;
    $("dashboard-error").classList.remove("hidden");
  } finally {
    $("refresh").disabled = false;
  }
}

function render(data) {
  const s = data.summary || {};
  if (data.range?.logs_truncated) {
    $("dashboard-notice").textContent = `This view is based on the newest ${number(data.range.max_logs)} logs in the selected window. Increase DASHBOARD_MAX_LOGS or use a narrower window for a complete view.`;
    $("dashboard-notice").classList.remove("hidden");
  }
  $("updated").textContent = `Updated ${new Date(data.generated_at).toLocaleString()} · last ${data.range?.days || state.days} days`;
  $("metrics").innerHTML = [
    ["Enhancements", number(s.enhancements), `${number(s.byok_enhancements)} via BYOK`],
    ["Active users", number(s.active_users), `${number(s.total_users)} total accounts`],
    ["Failures", number(s.failures), s.failures ? "Needs attention" : "No recorded failures"],
    ["Passive events", number(s.passive_events), "Learning signals"],
    ["Voice input", number(s.voice_enhancements), `${number(s.voice_transcriptions)} transcribed · ${number(s.voice_transcription_failures)} failed`],
    ["Saved prompts", number(s.saved_prompts), "Across all accounts"],
    ["Feedback", number(s.feedback_total), `${number(s.feedback_up)} positive · ${number(s.feedback_down)} negative`],
  ].map(([label, value, detail]) => `<article class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-detail">${detail}</div></article>`).join("");

  renderDaily(data.daily || []);
  renderBars("platforms", data.breakdowns?.platforms || {});
  renderBars("modes", data.breakdowns?.modes || {});
  renderBars("providers", data.breakdowns?.providers || {});
  renderBars("input-methods", data.breakdowns?.input_methods || {});
  renderFeedback(s.feedback_up, s.feedback_down);
  $("latency").innerHTML = [["Average", s.avg_latency_seconds], ["P50", s.p50_latency_seconds], ["P95", s.p95_latency_seconds]].map(([label, value]) => `<div class="latency-card"><span>${label}</span><strong>${seconds(value)}</strong></div>`).join("");
  renderStatus(data.system || {});
  renderCapacity(data.system?.providers || {});
  renderFailures(data.failures || []);
}

function renderDaily(items) {
  const rows = items.filter((item) => item.date !== "unknown");
  if (!rows.length) { $("daily-chart").innerHTML = `<div class="empty">No activity in this window.</div>`; return; }
  const max = Math.max(1, ...rows.flatMap((x) => [x.enhancements || 0, x.failures || 0]));
  $("daily-chart").innerHTML = rows.map((item) => {
    const e = Math.round(((item.enhancements || 0) / max) * 100);
    const f = Math.round(((item.failures || 0) / max) * 100);
    return `<div class="day-column" title="${escapeHtml(item.date)}: ${item.enhancements || 0} enhancements, ${item.failures || 0} failures"><div class="day-bars"><div class="day-bar" style="height:${e}%"></div><div class="day-bar failure" style="height:${f}%"></div></div><span class="day-label">${escapeHtml(item.date.slice(5))}</span></div>`;
  }).join("");
}

function renderBars(id, values) {
  const entries = Object.entries(values).filter(([, count]) => count > 0);
  if (!entries.length) { $(id).innerHTML = `<div class="empty">No data yet.</div>`; return; }
  const max = Math.max(...entries.map(([, count]) => count), 1);
  $(id).innerHTML = entries.slice(0, 8).map(([label, count]) => `<div class="bar-row"><span class="bar-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.round((count / max) * 100)}%"></div></div><span class="bar-count">${number(count)}</span></div>`).join("");
}

function renderFeedback(up = 0, down = 0) {
  const total = up + down;
  const rate = total ? Math.round((up / total) * 100) : 0;
  $("feedback-up").style.width = `${rate}%`;
  $("feedback-up-label").textContent = number(up);
  $("feedback-down-label").textContent = number(down);
  $("feedback-rate").textContent = total ? `${rate}% positive` : "No ratings";
}

function renderStatus(system) {
  const qdrant = system.qdrant || {};
  const embedding = system.embedding || {};
  const provider = system.providers || {};
  const providerCount = Object.values(provider.providers || {}).filter((x) => x.keys_configured > 0).length;
  const deadModels = (provider.dead_models || []).length;
  const rows = [
    ["MongoDB", system.mongo_connected ? "Connected" : "Fallback / offline", system.mongo_connected],
    ["Qdrant", qdrant.connected ? "Connected" : "Unavailable", qdrant.connected],
    ["Embeddings", embedding.loaded ? "Loaded" : "Unavailable", embedding.loaded],
    ["LLM providers", `${providerCount} configured`, providerCount > 0],
    ["Dead models", deadModels ? `${deadModels} quarantined` : "None", !deadModels],
    ["Fallback chain", `${(provider.chain || []).length} models`, (provider.chain || []).length > 0],
    ["After Groq", (provider.extra_models || []).length ? provider.extra_models.join(", ") : "Nothing (SERVER_EXTRA_MODELS unset)", (provider.extra_models || []).length > 0],
  ];
  $("system-status").innerHTML = rows.map(([label, value, ok]) => `<div class="status-row"><span>${label}</span><span class="status-value ${ok ? "" : "warn"}">${escapeHtml(value)}</span></div>`).join("");
}

/**
 * Each model in the shared chain, with what its keys have left as the
 * provider last reported it (x-ratelimit-* headers). Requests left is the
 * day's allowance; tokens left is this minute's. A model nobody has been
 * routed to since the server started has nothing to show yet.
 */
function renderCapacity(provider) {
  const chain = provider.chain || [];
  const headroom = provider.headroom || {};
  const dead = new Set(provider.dead_models || []);
  if (!chain.length) { $("capacity").innerHTML = `<div class="empty">No models configured.</div>`; return; }
  const ago = (at) => {
    if (!at) return "";
    const s = Math.max(0, Math.round(Date.now() / 1000 - at));
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
  };
  const rows = [];
  for (const label of chain) {
    const keys = Object.entries(headroom[label] || {});
    if (dead.has(label)) { rows.push(capRow(label, "", `<span class="cap-off">Quarantined: the provider says this model is gone.</span>`, "")); continue; }
    if (!keys.length) { rows.push(capRow(label, "", `<span class="cap-off">No requests through it since the server started.</span>`, "")); continue; }
    for (const [index, h] of keys) {
      const limit = h.requests_limit || 0;
      const left = h.requests_left ?? null;
      const pct = limit && left !== null ? Math.round((left / limit) * 100) : 0;
      const tokens = h.tokens_limit ? `${number(h.tokens_left ?? 0)} of ${number(h.tokens_limit)} tokens this minute` : "";
      const meter = left === null ? `<span class="cap-off">No limits reported.</span>` :
        `<div class="bar-track"><div class="bar-fill${pct < 15 ? " low" : ""}" style="width:${pct}%"></div></div>` +
        `<div class="cap-figures"><b>${number(left)}</b> of ${number(limit)} requests left today${tokens ? " · " + escapeHtml(tokens) : ""}</div>`;
      const when = [h.requests_reset ? `resets in ${escapeHtml(h.requests_reset)}` : "", ago(h.at)].filter(Boolean).join(" · ");
      rows.push(capRow(label, `key ${Number(index) + 1}`, meter, when));
    }
  }
  $("capacity").innerHTML = rows.join("");
}

function capRow(label, sub, meter, when) {
  return `<div class="cap-row"><div class="cap-name" title="${escapeHtml(label)}">${escapeHtml(label)}${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</div>` +
    `<div class="cap-meter">${meter}</div><div class="cap-when">${when}</div></div>`;
}

function renderFailures(items) {
  if (!items.length) { $("failures").innerHTML = `<div class="empty">No recorded failures.</div>`; return; }
  $("failures").innerHTML = items.map((item) => `<div class="failure-row"><span class="failure-operation">${escapeHtml(item.operation)}</span><span class="failure-reason">${escapeHtml(item.reason)}</span><span class="failure-platform">${escapeHtml(item.platform)}</span><span class="failure-time">${item.timestamp ? escapeHtml(new Date(item.timestamp).toLocaleString()) : "—"}</span></div>`).join("");
}

$("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.key = $("builder-key").value.trim();
  if (!state.key) return;
  showDashboard();
  await loadDashboard();
});
$("days").addEventListener("change", () => { state.days = Number($("days").value); loadDashboard(); });
$("refresh").addEventListener("click", loadDashboard);
$("lock").addEventListener("click", lockDashboard);
