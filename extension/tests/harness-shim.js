/* The chrome.* shim and fake backends shared by the harness pages.
   Loaded before content.js; see pill-harness.html for the drivers. */
// chrome.* shim — enough of the API for content.js to boot and run the draft flow.
(() => {
  const mk = (backing) => ({
    get(keys, cb) {
      const store = JSON.parse(backing.getItem("pm") || "{}");
      const ks = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : keys == null ? Object.keys(store) : Object.keys(keys);
      const out = {}; ks.forEach(k => { if (k in store) out[k] = store[k]; });
      if (cb) cb(out); return Promise.resolve(out);
    },
    set(obj, cb) { const store = JSON.parse(backing.getItem("pm") || "{}"); Object.assign(store, obj); backing.setItem("pm", JSON.stringify(store)); if (cb) cb(); return Promise.resolve(); },
    remove(k, cb) { const store = JSON.parse(backing.getItem("pm") || "{}"); (Array.isArray(k) ? k : [k]).forEach(x => delete store[x]); backing.setItem("pm", JSON.stringify(store)); if (cb) cb(); return Promise.resolve(); },
  });
  window.chrome = {
    storage: { local: mk(localStorage), session: mk(sessionStorage), onChanged: { addListener() {} } },
    runtime: {
      id: "pill-harness",
      lastError: null,
      // Routes every enhancement to the direct path, which the port below fakes.
      sendMessage(msg, cb) {
        // PM_GET_SHORTCUT: window.FAKE_SHORTCUT, "" for "Chrome left it unassigned".
        const r = msg?.type === "PM_GET_ROUTE" ? { route: "direct", hasKey: true }
          : msg?.type === "PM_GET_SHORTCUT" ? { shortcut: window.FAKE_SHORTCUT ?? "Ctrl+Shift+E" }
          : undefined;
        if (cb) setTimeout(() => cb(r), 0); return Promise.resolve(r);
      },
      onMessage: { addListener() {} },
      // A fake provider stream: a style-specific rewrite in a few tokens. The
      // harness's FAKE object (below) sets the text, speed and failures.
      connect() {
        const msgL = [], discL = [];
        let timer = null, closed = false;
        const port = {
          onMessage: { addListener(f) { msgL.push(f); } },
          onDisconnect: { addListener(f) { discL.push(f); } },
          postMessage(m) {
            if (m.type !== "PM_ENHANCE_STREAM") return;
            const F = window.FAKE; F.calls.push(m.mode);
            const text = F.text[m.mode] || F.text.deep;
            const words = text.split(/(?<= )/);
            let i = 0;
            const tick = () => {
              if (closed) return;
              if (F.failNext) { F.failNext = false; msgL.forEach(f => f({ type: "error", error: "Rate limited \u2014 try again in 20 s" })); return; }
              if (i < words.length) { msgL.forEach(f => f({ type: "token", token: words[i++] })); timer = setTimeout(tick, F.delay); }
              else msgL.forEach(f => f({ type: "done", enhanced: text, model: "fake" }));
            };
            timer = setTimeout(tick, F.delay);
          },
          disconnect() { closed = true; clearTimeout(timer); },
        };
        return port;
      },
      getURL: (p) => p,
    },
  };
})();
// Consent is a one-time prompt in the real extension; the harness has given it.
(() => { const s = JSON.parse(localStorage.getItem("pm") || "{}"); if (s.pm_data_consent_v1 === undefined) { s.pm_data_consent_v1 = true; localStorage.setItem("pm", JSON.stringify(s)); } })();
// A fake Prompt Memory server for the library: saved prompts, history, usage,
// feedback. Signed out until H.signIn(); every call is logged in FAKE_API.calls.
window.FAKE_API = {
  calls: [], usage: { count: 9, limit: 15 }, nextId: 100,
  prompts: [
    { id: "p1", title: "Code review template", content: "Review this diff like a senior engineer: correctness first, then naming, then tests. Flag anything that changes behaviour.", tags: ["coding", "review"] },
    { id: "p2", title: "", content: "You are my writing editor. Cut every sentence that does not earn its place and keep my voice.", tags: ["writing"] },
    { id: "p3", title: "Explain like a teacher", content: "Explain the concept step by step with one concrete example, then a common misconception.", tags: [] },
    { id: "p4", title: "Bug report triage", content: "Given this bug report, list the likely root causes ranked by probability and the one log line that would confirm each.", tags: ["debug"] },
    { id: "p5", title: "Product spec critic", content: "Read this spec and list the three decisions it leaves unmade.", tags: ["product"] },
  ],
  history: [
    { original: "hw do i sort a list of dicts by a key in python", enhanced: "Show me how to sort a list of dictionaries in Python by a specific key, handling dictionaries that lack it.", mode: "deep", latency: 1.2, timestamp: new Date(Date.now() - 3e5).toISOString(), log_id: "h1" },
    { original: "write email to landlord about leak", enhanced: "Draft a polite but firm email to my landlord reporting a ceiling leak, asking for a repair date this week.", mode: "quick", latency: 0.8, timestamp: new Date(Date.now() - 7e6).toISOString(), log_id: "h2" },
  ],
};
(() => {
  const real = window.fetch.bind(window);
  const API = "https://siddhm11-prompt-engine.hf.space";
  const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  window.fetch = (url, opts = {}) => {
    if (typeof url !== "string" || !url.startsWith(API)) return real(url, opts);
    const A = window.FAKE_API, path = url.slice(API.length).split("?")[0], method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;
    A.calls.push({ method, path, body });
    if (path === "/saved-prompts" && method === "GET") return json({ prompts: A.prompts });
    if (path === "/saved-prompts" && method === "POST") {
      if (A.prompts.some((p) => p.content === body.content)) return json({ duplicate: true });
      A.prompts.unshift({ id: "p" + A.nextId++, title: body.title || "", content: body.content, tags: body.tags || [] });
      return json({ ok: true });
    }
    const one = path.match(/^\/saved-prompts\/(.+)$/);
    if (one && method === "DELETE") { A.prompts = A.prompts.filter((p) => p.id !== one[1]); return json({ ok: true }); }
    if (one && method === "PUT") { const p = A.prompts.find((x) => x.id === one[1]); Object.assign(p || {}, body); return json({ ok: true }); }
    if (path === "/enhance/history") return json({ history: A.history });
    if (path === "/enhance/usage") return json(A.usage);
    if (path === "/feedback/mine") return json({ feedback: [] });
    return json({});
  };
})();
window.FAKE = {
  calls: [], delay: 25, failNext: false,
  text: {
    deep: "Show me how to sort a list of dictionaries in Python by a specific key, handling cases where some dictionaries might not have that key. Explain the choice between a default value and filtering, and include a short code example.",
    quick: "How do I sort a list of Python dicts by a key when some dicts are missing it?",
    creative: "Explore the different ways to sort Python dictionaries by a key that some of them lack. What are the trade-offs of defaults, filtering or custom key functions, and when would each surprise me?",
  },
};
