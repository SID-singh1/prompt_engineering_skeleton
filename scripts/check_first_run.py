"""Walk the real extension through a new user's first minutes.

A fresh profile each phase, the real unpacked extension, and fakes at the
network edge: a ChatGPT-shaped page at https://chatgpt.com, the provider at
https://api.groq.com, and the Prompt Memory server (the free tier's token and
stream, and the signed-in library). Checks:

  install    the home tab opens with no wall; the free token is fetched
  popup      fits; deep links; key, sign-in and sign-out; after first use
  free use   Improve → consent worded for the free tier → the rewrite lands
             in the box, sent as the draft alone → Undo → the limit offers
             sign-in, with the draft as it was
  classic    with the classic controls: meet tip → card tip → save tip
  limits     tips retire after use, after three showings, and when switched off
  signed in  the // tip, retired by using //

Needs Playwright's bundled Chromium (branded Chrome ignores --load-extension):
    pip install playwright && python -m playwright install chromium
    python3 scripts/check_first_run.py

Where that Chromium will not start (some Windows machines refuse it with "side-
by-side configuration is incorrect"), Microsoft Edge still loads unpacked
extensions:
    PM_BROWSER_CHANNEL=msedge python3 scripts/check_first_run.py
"""
import base64
import json
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS", "1")

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Playwright is not installed: pip install playwright")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_extension_e2e import CHAT, EXT, REPLY, SAVED  # noqa: E402

checks = 0
CHANNEL = os.environ.get("PM_BROWSER_CHANNEL", "chromium")
JWT = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6InUxIn0.x"


def _jwt(payload):
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return f"eyJhbGciOiJub25lIn0.{body}.x"


ANON = _jwt({"exp": 4102444800, "sub": "anon_firstrun", "anon": True})
DRAFT = "yo how do i make my resume better for data science jobs, i have like 2 yrs exp"


def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        raise AssertionError(msg)


def provider(route):
    req = route.request
    if req.method == "GET" and req.url.endswith("/models"):
        route.fulfill(status=200, content_type="application/json", body='{"data": []}')
        return
    text = REPLY["deep"]
    sse = "".join(f"data: {json.dumps({'choices': [{'delta': {'content': text[i:i + 16]}}]})}\n\n"
                  for i in range(0, len(text), 16))
    route.fulfill(status=200, content_type="text/event-stream", body=sse + "data: [DONE]\n\n")


class Server:
    """The Prompt Memory API, as routers/auth.py and routers/prompts.py answer it."""

    def __init__(self, anon_limit=10):
        self.calls = []
        self.anon_used = 0
        self.anon_limit = anon_limit

    def __call__(self, route):
        req = route.request
        path = req.url.split(".hf.space", 1)[1].split("?")[0]
        auth = req.headers.get("authorization", "")
        anon = ANON in auth
        body = None
        if req.post_data:
            try:
                body = json.loads(req.post_data)
            except ValueError:
                body = None
        self.calls.append({"method": req.method, "path": path, "body": body, "anon": anon})
        reply = lambda obj, status=200: route.fulfill(status=status, content_type="application/json", body=json.dumps(obj))

        if path == "/auth/anonymous":
            return reply({"token": ANON, "anon": True, "daily_limit": self.anon_limit})
        if path == "/enhance/usage":
            return reply({"count": self.anon_used, "limit": self.anon_limit, "tier": "anon"} if anon
                         else {"count": 0, "limit": 15, "tier": "free"})
        if path == "/enhance/stream":
            mode = "quick" if anon else (body or {}).get("mode", "deep")
            if anon and self.anon_used >= self.anon_limit:
                refusal = {"error": "daily_limit_reached", "sign_in_available": True,
                           "detail": f"You've used today's {self.anon_limit} free rewrites. Sign in with Google (it's free) for more each day."}
                events = [refusal, {"done": True, "failed": True, **refusal}]
            else:
                text = REPLY[mode]
                events = [{"token": text[i:i + 16]} for i in range(0, len(text), 16)]
                if anon:
                    self.anon_used += 1
                events.append({"done": True, "failed": False, "mode": mode, "log_id": None if anon else "L1",
                               "usage_today": {"used": self.anon_used if anon else 1,
                                               "limit": self.anon_limit if anon else 15}})
            sse = "".join(f"data: {json.dumps(e)}\n\n" for e in events)
            return route.fulfill(status=200, content_type="text/event-stream", body=sse)
        if req.method == "GET" and path.startswith("/saved-prompts"):
            return reply({"prompts": SAVED})
        return route.fulfill(status=200, content_type="application/json", body="[]" if req.method == "GET" else "{}")

    def paths(self):
        return [c["path"] for c in self.calls]


class Profile:
    """A fresh Chromium profile with the extension, and the fakes routed."""

    def __init__(self, p, storage=None, server=None):
        self._tmp = tempfile.TemporaryDirectory()
        self.server = server or Server()
        self.ctx = p.chromium.launch_persistent_context(
            self._tmp.name, channel=CHANNEL, headless=True, viewport={"width": 1280, "height": 800},
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        self.ctx.route("https://chatgpt.com/**", lambda r: r.fulfill(status=200, content_type="text/html", body=CHAT))
        self.ctx.route("https://api.groq.com/**", provider)
        self.ctx.route("https://siddhm11-prompt-engine.hf.space/**", self.server)
        self.sw = self.ctx.service_workers[0] if self.ctx.service_workers else self.ctx.wait_for_event("serviceworker")
        self.ext = self.sw.url.split("/")[2]
        if storage is not None:
            self.sw.evaluate(f"chrome.storage.local.set({json.dumps(storage)})")
        self.errors = []

    def get(self, key):
        return self.sw.evaluate(f"chrome.storage.local.get({json.dumps(key)}).then(r => r[{json.dumps(key)}] ?? null)")

    def chat(self, ready="#pm-trigger"):
        page = self.ctx.new_page()
        page.on("pageerror", lambda e: self.errors.append(str(e)))
        page.goto("https://chatgpt.com/")
        page.wait_for_selector(ready, state="attached", timeout=10000)
        return page

    def popup(self, query="", size=(360, 600)):
        page = self.ctx.new_page()
        page.on("pageerror", lambda e: self.errors.append(str(e)))
        page.set_viewport_size({"width": size[0], "height": size[1]})
        page.goto(f"chrome-extension://{self.ext}/popup.html{query}")
        page.wait_for_timeout(400)
        return page

    def close(self):
        check(not self.errors, f"page errors: {self.errors}")
        self.ctx.close()
        self._tmp.cleanup()


def wait_until(page, js, timeout=8000):
    """page.wait_for_function, without it: that evaluates a string inside the
    page, which the extension's own pages refuse (CSP: no unsafe-eval), so it
    failed whenever the condition was not already true on the first look.
    page.evaluate goes through the debugger and is not subject to the CSP."""
    deadline = time.monotonic() + timeout / 1000
    while True:
        if page.evaluate(js):
            return
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for: {js}")
        page.wait_for_timeout(100)


def tip(page):
    return page.evaluate("document.getElementById('pm-tip')?.dataset.tip || ''")


def tip_title(page):
    return page.evaluate("document.querySelector('#pm-tip .pm-tip-title')?.textContent || ''")


def wait_tip(page, name, timeout=8000):
    page.wait_for_selector(f"#pm-tip[data-tip='{name}']", timeout=timeout)
    page.wait_for_timeout(250)


def type_prompt(page, text):
    page.click("#prompt-textarea")
    page.keyboard.type(text, delay=5)
    page.wait_for_timeout(250)


def box_text(page):
    return page.evaluate("document.getElementById('prompt-textarea').innerText.trim()")


def bar_text(page):
    return page.evaluate("document.getElementById('pm-simple')?.innerText.replace(/\\s+/g, ' ').trim() || ''")


CLASSIC = {"pm_simple_mode": False}


def main():
    with sync_playwright() as p:
        # ── Install: the home tab, no wall, and the free token fetched ───
        prof = Profile(p)
        page = next((pg for pg in prof.ctx.pages if "popup.html?onboarding=1" in pg.url), None)
        if page is None:
            page = prof.ctx.wait_for_event("page", timeout=8000)
        page.wait_for_load_state()
        page.wait_for_timeout(600)
        check("popup.html?onboarding=1" in page.url, "installing opens the home tab")
        check("pm-standalone" in page.evaluate("document.body.className"), "in the wide layout")
        check(page.inner_text("#hero-title") == "You're all set", "which says it is ready, not that setup is needed")
        check(page.locator("#pm-consent-agree").count() == 0 and page.locator("#screen-setup").count() == 0,
              "with no consent wall and no Google-or-key choice in front of it")
        check(page.is_visible("#hero-mock"), "it draws the button to look for")
        sites = [a.get_attribute("href") for a in page.locator(".hero .site").all()]
        check(len(sites) == 5 and "https://chatgpt.com/" in sites, f"and links the five chats, got {sites}")
        check(page.is_visible("#plan-free") and "10 Quick rewrites a day" in page.inner_text("#plan-free"),
              "the free plan is named with its daily allowance")
        check(page.is_visible("#google-login-btn"), "signing in is offered, not required")
        check(page.is_hidden("#key-row"), "the API key is folded into settings")
        check(page.inner_text("#head-state").strip() == "Free", "the header says Free")
        check(page.is_visible("#pin-hint"), "the install tab says how to pin the icon")
        check("/auth/anonymous" in prof.server.paths(), "the worker fetched the free token on install")
        check(prof.get("anon_token") == ANON, "and kept it")
        check(prof.get("pm_simple_mode") is True, "a new install starts with the simple controls")
        prof.close()

        # ── The toolbar popup ────────────────────────────────────────────
        prof = Profile(p)
        page = prof.popup()
        check(page.evaluate("document.body.scrollWidth") <= 360, "the popup fits the toolbar's width")
        b = page.locator("#google-login-btn").bounding_box()
        check(b and b["y"] + b["height"] <= 600, f"and Sign in is in view without scrolling, got {b}")
        check(page.is_hidden("#pin-hint"), "the popup leaves the pin hint to the install tab")
        page.close()
        page = prof.popup("#key")
        check(page.is_visible("#key-input") and page.evaluate("document.getElementById('advanced').open"),
              "#key opens the settings at the key form")
        check(page.get_attribute("#key-get-link", "href") == "https://console.groq.com/keys", "with a link to get one")
        page.click("#key-save")
        check("Paste your key first" in page.inner_text("#key-status"), "an empty key is caught before any request")
        page.fill("#key-input", "gsk_first_run_demo_9f2c")
        page.click("#key-save")
        wait_until(page, "document.getElementById('plan-free-title').textContent.includes('Groq key')", timeout=8000)
        check(prof.get("byok_key") == "gsk_first_run_demo_9f2c", "the tested key is saved")
        check("9f2c" in page.inner_text("#key-sub") and "gsk_first_run_demo" not in page.content(),
              "and shown by its last four characters only")
        page.close()
        prof.sw.evaluate(f"chrome.storage.local.set({{ token: '{JWT}', user_id: 'u1', email: 'you@example.com' }})")
        page = prof.popup()
        check(page.is_visible("#plan-in") and page.is_hidden("#plan-free"), "signed in: the account replaces the free plan")
        check(page.inner_text("#user-display") == "you@example.com", "with the account's email")
        check(page.is_visible("#hero-mock"), "before any rewrite the button is drawn")
        prof.sw.evaluate("chrome.storage.local.set({ pm_stats: { rewrites: 3 } })")
        page.wait_for_timeout(300)
        check(page.is_hidden("#hero-mock") and page.inner_text("#hero-title") == "Prompt Memory",
              "after the first rewrites the how-to folds away; the chat links stay")
        shortcut = page.inner_text("[data-command='enhance-prompt']").strip()
        # Chromium assigns the suggested key; Edge may not. Either way the
        # popup must say what is true, and offer the fix only when it is unset.
        assigned = prof.sw.evaluate("chrome.commands.getAll().then(c => c.find(x => x.name === 'enhance-prompt')?.shortcut || '')")
        check(shortcut == (assigned or "Not set") and page.is_hidden("#shortcut-fix") == bool(assigned),
              f"the popup shows the shortcut the browser actually assigned ({assigned!r}), got {shortcut!r}")
        page.click("#advanced > summary")
        page.uncheck("#tips-toggle")
        page.wait_for_timeout(200)
        check(prof.get("pm_tips_off") is True, "the tips switch is stored")
        page.click("#logout-btn")
        page.wait_for_timeout(300)
        check(prof.get("token") is None and page.is_visible("#plan-free"), "Sign out keeps the key and offers Sign in")
        page.close()
        prof.close()

        # ── Free use: no account, no key ─────────────────────────────────
        server = Server(anon_limit=2)
        prof = Profile(p, server=server)
        page = prof.chat("#pm-simple")
        page.wait_for_timeout(600)
        check(page.is_visible("#pm-simple .pm-simple-improve"), "Improve sits on the chat box")
        type_prompt(page, DRAFT)
        page.click("#pm-simple [data-act='improve']")
        page.wait_for_selector(".pm-modal-overlay.pm-visible", timeout=5000)
        consent = page.inner_text(".pm-modal")
        check("nothing is saved" in consent and "six recent messages" not in consent,
              "the first Improve asks first, in the free tier's words")
        check("/enhance/stream" not in server.paths(), "and nothing is sent before the answer")
        page.click("#pm-consent-accept")
        wait_until(page, f"document.getElementById('prompt-textarea').innerText.trim() === {json.dumps(REPLY['quick'])}",
                               timeout=8000)
        check(True, "the Quick rewrite lands in the chat box")
        check(prof.get("pm_data_consent_v1") is True, "the consent is kept")
        sent = next(c for c in server.calls if c["path"] == "/enhance/stream")
        check(sent["anon"], "sent with the free token")
        check(sent["body"]["prompt"] == DRAFT and sent["body"]["conversation_context"] == []
              and "byok_key" not in sent["body"] and "selected_prompt_ids" not in sent["body"],
              f"as the draft alone, got {sent['body']}")
        wait_until(page, "(document.getElementById('pm-simple')?.innerText || '').includes('Undo')", timeout=4000)
        bar = bar_text(page)
        check("Improved" in bar and "More detail" not in bar, f"the bar offers what the free tier can do, got {bar!r}")
        check("1 free left today" in bar, f"and says how many are left, got {bar!r}")
        page.click("#pm-simple [data-act='undo']")
        wait_until(page, f"document.getElementById('prompt-textarea').innerText.trim() === {json.dumps(DRAFT)}", timeout=4000)
        check(True, "Undo puts back exactly what was typed")
        page.click("#pm-simple [data-act='improve']")
        wait_until(page, "(document.getElementById('pm-simple')?.innerText || '').includes('Undo')", timeout=8000)
        check("last free one today" in bar_text(page), f"the last one says so, got {bar_text(page)!r}")
        page.click("#pm-simple [data-act='undo']")
        page.wait_for_timeout(300)
        page.click("#pm-simple [data-act='improve']")
        wait_until(page, "(document.getElementById('pm-simple')?.innerText || '').includes('Sign in for more')", timeout=8000)
        check(box_text(page) == DRAFT, "past the limit the draft stays as it was")
        check("Free rewrites used up" in bar_text(page), "and the bar says why, with Sign in right there")
        page.click("#pm-simple [data-act='more']")
        menu = page.inner_text("#pm-simple-menu")
        check("Sign in with Google for more" in menu and "Attach saved prompts" not in menu,
              "the menu offers what signing in adds, not controls that need it")
        prof.close()

        # ── Classic controls, first use with a key: meet → card → save ───
        prof = Profile(p, {**CLASSIC, "pm_data_consent_v1": True, "byok_provider": "groq", "byok_key": "gsk_test", "pm_mode": "deep"})
        page = prof.chat()
        wait_tip(page, "meet")
        check(tip_title(page) == "This is Prompt Memory", f"an empty chat box: what the plus button is, got {tip_title(page)!r}")
        tb, pb = page.locator("#pm-tip").bounding_box(), page.locator("#pm-trigger").bounding_box()
        check(tb["y"] + tb["height"] <= pb["y"] and abs((tb["x"] + tb["width"]) - (pb["x"] + pb["width"])) < 4,
              "pinned just above the pill, aligned to its side")
        check(page.evaluate("document.activeElement?.closest('#pm-tip') === null"), "and it never takes focus")
        type_prompt(page, "explain docker volumes to me")
        wait_until(page, "(document.querySelector('#pm-tip .pm-tip-title')?.textContent || '').startsWith('Want')", timeout=4000)
        check(True, "once there is text, the tip offers to rewrite it")
        page.click("#pm-tip .pm-tip-primary")
        page.wait_for_selector("#pm-card .pm-card-title", timeout=8000)
        wait_until(page, "(document.querySelector('#pm-card .pm-card-title')?.textContent || '').includes('Rewrite')", timeout=8000)
        check(tip(page) == "", "the floating tip goes away when the card opens")
        check(page.is_visible("#pm-card-tip") and "Replace draft" in page.inner_text("#pm-card-tip"),
              "the first card explains Replace and the style buttons")
        check((prof.get("pm_stats") or {}).get("rewrites") == 1, "the first rewrite is counted")
        page.click("#pm-card-accept")
        wait_tip(page, "save")
        check(tip_title(page) == "Keep the prompts that work" and "Sign in" in page.inner_text("#pm-tip"),
              "after the first Replace, signed out: how to keep prompts, with Sign in")
        check((prof.get("pm_stats") or {}).get("inserts") == 1, "the Replace is counted")
        page.click("#pm-tip .pm-tip-x")
        check(tip(page) == "", "× dismisses it")
        page.close()
        page = prof.chat()
        page.wait_for_timeout(3200)
        check(tip(page) == "", "after the first rewrite the plus-button tip never comes back")
        type_prompt(page, "and what about bind mounts")
        page.click("#pm-trigger")
        page.wait_for_selector("#pm-card .pm-card-accept, #pm-card-accept", timeout=8000)
        check(page.locator("#pm-card-tip").count() == 0, "the card tip is shown for the first rewrite only")
        seen = prof.get("pm_tips") or {}
        check(all(k in seen for k in ("meet", "card", "save")), f"each tip is recorded as done, got {sorted(seen)}")
        prof.close()

        # ── Limits: three showings at most, and the switch ───────────────
        prof = Profile(p, {**CLASSIC, "pm_data_consent_v1": True, "byok_provider": "groq", "byok_key": "gsk_test"})
        for n in range(1, 5):
            page = prof.chat()
            page.wait_for_timeout(3000)
            shown = tip(page) == "meet"
            check(shown == (n <= 3), f"visit {n}: the plus-button tip {'shows' if n <= 3 else 'has retired'}")
            page.close()
        prof.sw.evaluate("chrome.storage.local.remove('pm_tip_shows')")
        prof.sw.evaluate("chrome.storage.local.set({ pm_tips_off: true })")
        page = prof.chat()
        page.wait_for_timeout(3000)
        check(tip(page) == "", "with tips switched off, none shows")
        prof.close()

        # ── Signed in, with saved prompts: the // tip ────────────────────
        prof = Profile(p, {**CLASSIC, "pm_data_consent_v1": True, "token": JWT, "user_id": "u1", "email": "u@example.com",
                           "pm_stats": {"rewrites": 2, "inserts": 1}, "pm_tips": {"meet": 1, "card": 1, "save": 1},
                           "pm_slash": True})
        page = prof.chat()
        page.wait_for_timeout(800)
        page.click("#prompt-textarea")
        wait_tip(page, "slash")
        check("//" in page.inner_text("#pm-tip"), "focusing the chat box: type // for a saved prompt")
        page.keyboard.type("Look at this: ")
        page.keyboard.type("//rev", delay=40)
        page.wait_for_selector("#pm-caret .pm-caret-row", timeout=5000)
        page.keyboard.press("Enter")
        page.wait_for_timeout(500)
        check((prof.get("pm_stats") or {}).get("slash") == 1 and (prof.get("pm_tips") or {}).get("slash"),
              "using // retires the tip")
        prof.close()

    print(f"{checks} first-run checks PASS")


if __name__ == "__main__":
    main()
