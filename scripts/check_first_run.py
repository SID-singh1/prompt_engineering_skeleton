"""Walk the real extension through a new user's first minutes.

A fresh profile each phase, the real unpacked extension, and the same two fakes
as check_extension_e2e.py: a ChatGPT-shaped page at https://chatgpt.com and
the provider at https://api.groq.com (and the Prompt Memory server, for the
signed-in phase). Checks:

  install    the welcome tab opens; welcome → setup → key → ready
  popup      deep links, the shortcut, tips switch, what changes after use
  not set up the ⊕ tip says "set it up", and the setup modal fits and routes
  first use  meet tip → Rewrite it → card tip → Replace → save tip
  limits     tips retire after use, after three showings, and when switched off
  signed in  the // tip, retired by using //

Needs Playwright's bundled Chromium (branded Chrome ignores --load-extension):
    pip install playwright && python -m playwright install chromium
    python3 scripts/check_first_run.py
"""
import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS", "1")

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Playwright is not installed: pip install playwright")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_extension_e2e import CHAT, EXT, REPLY, SAVED  # noqa: E402

checks = 0
JWT = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6InUxIn0.x"


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


def server(route):
    req, path = route.request, route.request.url.split(".hf.space", 1)[1]
    if req.method == "GET" and path.startswith("/saved-prompts"):
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"prompts": SAVED}))
    else:
        route.fulfill(status=200, content_type="application/json", body="[]" if req.method == "GET" else "{}")


class Profile:
    """A fresh Chromium profile with the extension, and the fakes routed."""

    def __init__(self, p, storage=None):
        self._tmp = tempfile.TemporaryDirectory()
        self.ctx = p.chromium.launch_persistent_context(
            self._tmp.name, channel="chromium", headless=True, viewport={"width": 1280, "height": 800},
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        self.ctx.route("https://chatgpt.com/**", lambda r: r.fulfill(status=200, content_type="text/html", body=CHAT))
        self.ctx.route("https://api.groq.com/**", provider)
        self.ctx.route("https://siddhm11-prompt-engine.hf.space/**", server)
        self.sw = self.ctx.service_workers[0] if self.ctx.service_workers else self.ctx.wait_for_event("serviceworker")
        self.ext = self.sw.url.split("/")[2]
        if storage is not None:
            self.sw.evaluate(f"chrome.storage.local.set({json.dumps(storage)})")
        self.errors = []

    def get(self, key):
        return self.sw.evaluate(f"chrome.storage.local.get({json.dumps(key)}).then(r => r[{json.dumps(key)}] ?? null)")

    def chat(self):
        page = self.ctx.new_page()
        page.on("pageerror", lambda e: self.errors.append(str(e)))
        page.goto("https://chatgpt.com/")
        page.wait_for_selector("#pm-trigger", state="attached", timeout=10000)
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


def visible_screen(page):
    return page.evaluate("['welcome','setup','ready'].find(n => !document.getElementById('screen-' + n).hidden) || ''")


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


def main():
    with sync_playwright() as p:
        # ── Install: the welcome tab, and the three screens in order ─────
        prof = Profile(p)
        page = next((pg for pg in prof.ctx.pages if "popup.html?onboarding=1" in pg.url), None)
        if page is None:
            page = prof.ctx.wait_for_event("page", timeout=8000)
        page.wait_for_load_state()
        page.wait_for_timeout(400)
        check("popup.html?onboarding=1" in page.url, "installing opens the welcome tab")
        check(visible_screen(page) == "welcome", "a new user sees the welcome screen first")
        check("pm-standalone" in page.evaluate("document.body.className"), "the tab uses the wide layout")
        check("Better prompts" in page.inner_text("#screen-welcome h1"), "which says what the extension is for")
        check(page.locator("#screen-welcome .step").count() == 3, "in three steps")
        check(page.is_hidden("#head-state"), "and does not claim a setup state before consent")
        page.click("#pm-consent-agree")
        page.wait_for_timeout(300)
        check(prof.get("pm_data_consent_v1") is True, "Agree stores the consent")
        check(visible_screen(page) == "setup", "then asks how to rewrite")
        check(page.inner_text("#head-state").strip() == "Setup needed", "and the header says setup is needed")
        check(page.is_visible("#google-login-btn") and page.is_visible("#key-open"), "both ways are offered side by side")
        page.click("#key-open")
        check(page.is_visible("#key-input") and page.is_visible("#key-get-link"), "the key form opens with a link to get one")
        check(page.get_attribute("#key-get-link", "href") == "https://console.groq.com/keys", "which goes to the Groq console")
        page.click("#key-save")
        check("Paste your key first" in page.inner_text("#key-status"), "an empty key is caught before any request")
        page.fill("#key-input", "gsk_first_run_demo_9f2c")
        page.click("#key-save")
        page.wait_for_function("!document.getElementById('screen-ready').hidden", timeout=8000)
        check(prof.get("byok_key") == "gsk_first_run_demo_9f2c", "the tested key is saved")
        check(page.inner_text("#ready-heading").startswith("You're ready"), "and the page says what to do next")
        sites = [a.get_attribute("href") for a in page.locator("#ready-card .site").all()]
        check(len(sites) == 5 and "https://chatgpt.com/" in sites and "https://claude.ai/new" in sites,
              f"with one-click links to the five chats, got {sites}")
        check(page.inner_text("#head-state").strip() == "Ready", "the header says Ready")
        check("9f2c" in page.inner_text("#key-sub"), "the key is shown by its last four characters only")
        check("gsk_first_run_demo" not in page.content(), "and never displayed back")
        prof.close()

        # ── The toolbar popup: the same screens, sized for the toolbar ───
        prof = Profile(p, {"pm_data_consent_v1": True})
        page = prof.popup()
        check(visible_screen(page) == "setup", "the popup opens where the user is: setup")
        check(page.evaluate("document.body.scrollWidth") <= 360, "and fits the popup's width")
        page.close()
        page = prof.popup("#key")
        check(page.is_visible("#key-input"), "#key opens straight at the key form")
        page.close()
        prof.sw.evaluate("chrome.storage.local.clear()")
        page = prof.popup()
        b = page.locator("#pm-consent-agree").bounding_box()
        check(b and b["y"] + b["height"] <= 600, "in the 600px popup the consent button is in view without scrolling")
        page.close()
        prof.sw.evaluate(f"chrome.storage.local.set({{ pm_data_consent_v1: true, byok_key: 'gsk_x_1234', byok_provider: 'groq', token: '{JWT}', user_id: 'u1', email: 'you@example.com' }})")
        page = prof.popup()
        check(visible_screen(page) == "ready" and page.is_visible("#acct-in"), "signed in and with a key: ready, account shown")
        check(page.inner_text("#user-display") == "you@example.com", "with the account's email")
        check(page.is_visible("#ready-card .steps"), "before any rewrite the how-to steps are shown")
        prof.sw.evaluate("chrome.storage.local.set({ pm_stats: { rewrites: 3 } })")
        page.wait_for_timeout(300)
        check(page.is_hidden("#ready-card .steps") and page.inner_text("#ready-heading").startswith("Use it"),
              "after the first rewrites the steps fold away; the chat links stay")
        shortcut = page.inner_text("[data-command='enhance-prompt']").strip()
        check(shortcut and shortcut != "Not set" and page.is_hidden("#shortcut-fix"),
              f"the popup shows the shortcut Chrome actually assigned, got {shortcut!r}")
        page.uncheck("#tips-toggle")
        page.wait_for_timeout(200)
        check(prof.get("pm_tips_off") is True, "the tips switch is stored")
        page.click("#logout-btn")
        page.wait_for_timeout(300)
        check(prof.get("token") is None and page.is_visible("#acct-out"), "Sign out keeps the key and shows Sign in")
        page.close()
        prof.close()

        # ── Not set up yet: the tip leads to setup, and setup fits ───────
        prof = Profile(p, {"pm_data_consent_v1": True})
        page = prof.chat()
        wait_tip(page, "meet")
        check(tip_title(page) == "Prompt Memory is ready to set up", f"with nothing set up the tip says so, got {tip_title(page)!r}")
        check("pm-pill-hint" in page.get_attribute("#pm-trigger", "class"), "and the pill draws the eye")
        page.click("#pm-tip .pm-tip-primary")
        page.wait_for_selector(".pm-modal-overlay.pm-visible", timeout=5000)
        modal = page.locator(".pm-modal").bounding_box()
        google = page.locator("#pm-setup-signin").bounding_box()
        check(google["y"] + google["height"] <= modal["y"] + modal["height"],
              "the setup modal shows both options without scrolling (the Google one was below the fold)")
        check(page.evaluate("getComputedStyle(document.querySelector('.pm-modal-body')).whiteSpace") == "normal",
              "and does not render its template's line breaks as blank space")
        with prof.ctx.expect_page() as new:
            page.click("#pm-setup-byok")
        tab = new.value
        tab.wait_for_load_state()
        check(tab.url.endswith("popup.html?onboarding=1#key"), f"Add a free key opens the key step, got {tab.url}")
        tab.wait_for_timeout(400)
        check(tab.is_visible("#key-input"), "with the key form already open")
        check(prof.get("pm_tips", ) and prof.get("pm_tips").get("meet"), "acting on a tip retires it")
        prof.close()

        # ── First use, with a key: meet → card → save ────────────────────
        prof = Profile(p, {"pm_data_consent_v1": True, "byok_provider": "groq", "byok_key": "gsk_test", "pm_mode": "deep"})
        page = prof.chat()
        wait_tip(page, "meet")
        check(tip_title(page) == "This is Prompt Memory", f"an empty chat box: what the plus button is, got {tip_title(page)!r}")
        tb, pb = page.locator("#pm-tip").bounding_box(), page.locator("#pm-trigger").bounding_box()
        check(tb["y"] + tb["height"] <= pb["y"] and abs((tb["x"] + tb["width"]) - (pb["x"] + pb["width"])) < 4,
              "pinned just above the pill, aligned to its side")
        check(page.evaluate("document.activeElement?.closest('#pm-tip') === null"), "and it never takes focus")
        type_prompt(page, "explain docker volumes to me")
        page.wait_for_function("(document.querySelector('#pm-tip .pm-tip-title')?.textContent || '').startsWith('Want')", timeout=4000)
        check(True, "once there is text, the tip offers to rewrite it")
        page.click("#pm-tip .pm-tip-primary")
        page.wait_for_selector("#pm-card .pm-card-title", timeout=8000)
        page.wait_for_function("(document.querySelector('#pm-card .pm-card-title')?.textContent || '').includes('Rewrite')", timeout=8000)
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
        prof = Profile(p, {"pm_data_consent_v1": True, "byok_provider": "groq", "byok_key": "gsk_test"})
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
        page.keyboard.press("Meta+Shift+L")
        page.wait_for_timeout(300)
        prof.close()

        # ── Signed in, with saved prompts: the // tip ────────────────────
        prof = Profile(p, {"pm_data_consent_v1": True, "token": JWT, "user_id": "u1", "email": "u@example.com",
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
