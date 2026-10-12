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
        // ?anon=1, or H.anon(): the free tier, served by the fake server below.
        // Signed in (a token in storage) goes to the server too; otherwise direct.
        const store = JSON.parse(localStorage.getItem("pm") || "{}");
        const tier = store.token ? "backend" : window.FAKE_ANON ? "anon" : "direct";
        if (msg?.type === "PM_START_GOOGLE_AUTH") {
          setTimeout(() => {
            const s2 = JSON.parse(localStorage.getItem("pm") || "{}");
            s2.token = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6InUxIn0.x";
            s2.email = "friend@example.com";
            localStorage.setItem("pm", JSON.stringify(s2));
            cb && cb({ ok: true, email: "friend@example.com" });
          }, 700);
          return Promise.resolve();
        }
        const r = msg?.type === "PM_GET_ROUTE"
            ? (tier === "anon" ? { route: "anon", anonToken: "anon.fake", anonLimit: window.FAKE_API.anonLimit }
              : tier === "backend" ? { route: "backend", signedIn: true } : { route: "direct", hasKey: true })
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
// The controls: a new install gets the simple ones, but the check scripts
// drive the classic ones, so the harness starts classic unless the URL asks
// for simple (?simple=1) or the free tier (?anon=1, which is simple-only).
(() => {
  const s = JSON.parse(localStorage.getItem("pm") || "{}");
  if (s.pm_data_consent_v1 === undefined) s.pm_data_consent_v1 = true;
  if (s.pm_simple_mode === undefined) s.pm_simple_mode = /[?&](simple|anon)=1/.test(location.search);
  localStorage.setItem("pm", JSON.stringify(s));
})();
// A fake Prompt Memory server for the library: saved prompts, history, usage,
// feedback. Signed out until H.signIn(); every call is logged in FAKE_API.calls.
window.FAKE_ANON = /[?&]anon=1/.test(location.search);
window.FAKE_API = {
  calls: [], usage: { count: 9, limit: 15 }, nextId: 100,
  // The free tier's allowance; anonUsed counts this page's rewrites against it.
  anonLimit: 10, anonUsed: 0,
  prompts: [
    { id: "p1", title: "Code review template", content: "Review this diff like a senior engineer: correctness first, then naming, then tests. Flag anything that changes behaviour.", tags: ["coding", "review"], created_at: new Date(Date.now() - 2 * 864e5).toISOString() },
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
      // As the real server answers (routers/saved_prompts.py): the id, and a
      // duplicate named by the one already there.
      const dup = A.prompts.find((p) => p.content === body.content);
      if (dup) return json({ id: dup.id, duplicate: true });
      const id = "p" + A.nextId++;
      A.prompts.unshift({ id, title: body.title || "", content: body.content, tags: body.tags || [] });
      return json({ id, message: "Prompt saved." });
    }
    const one = path.match(/^\/saved-prompts\/(.+)$/);
    if (one && method === "DELETE") { A.prompts = A.prompts.filter((p) => p.id !== one[1]); return json({ ok: true }); }
    if (one && method === "PUT") { const p = A.prompts.find((x) => x.id === one[1]); Object.assign(p || {}, body); return json({ ok: true }); }
    if (path === "/enhance/history") return json({ history: A.history });
    const anon = /anon\.fake/.test(opts.headers?.Authorization || "");
    if (path === "/enhance/usage") return json(anon ? { count: A.anonUsed, limit: A.anonLimit, tier: "anon" } : A.usage);
    if (path === "/enhance/stream") {
      // As routers/prompts.py streams it: tokens, then a done event. The free
      // tier is Quick only and refuses past its allowance, offering sign-in.
      const F = window.FAKE, mode = anon ? "quick" : body.mode;
      F.calls.push(mode);
      const enc = new TextEncoder();
      const ev = (o) => enc.encode(`data: ${JSON.stringify(o)}\n\n`);
      const stream = new ReadableStream({
        start(c) {
          if (anon && A.anonUsed >= A.anonLimit) {
            const refusal = { error: "daily_limit_reached", detail: `You've used today's ${A.anonLimit} free rewrites. Sign in with Google (it's free) for more each day.`, sign_in_available: true };
            c.enqueue(ev(refusal)); c.enqueue(ev({ done: true, failed: true, ...refusal })); c.close(); return;
          }
          const words = (F.text[mode] || F.text.deep).split(/(?<= )/);
          let i = 0;
          const tick = () => {
            if (i < words.length) { c.enqueue(ev({ token: words[i++] })); setTimeout(tick, F.delay); return; }
            if (anon) A.anonUsed++;
            c.enqueue(ev({ done: true, failed: false, log_id: anon ? null : "L" + Date.now(), mode,
              usage_today: anon ? { used: A.anonUsed, limit: A.anonLimit, tier: "anon" } : { used: ++A.usage.count, limit: A.usage.limit } }));
            c.close();
          };
          setTimeout(tick, F.delay);
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    }
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
