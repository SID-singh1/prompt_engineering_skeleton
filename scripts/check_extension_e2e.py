"""Load the real unpacked extension and run the style flow end to end.

Unlike check_card_styles.py, nothing here is shimmed: the real service
worker, chrome.storage.session, the stream port and providers.js all run.
Two things are faked at the network edge:

  https://chatgpt.com/*   a minimal chat page with ChatGPT's composer id,
                          so the content script injects as it would there;
  https://api.groq.com/*  the provider, answering the direct route. It
                          records every request, so the checks can assert
                          which style instructions and temperature the
                          extension actually sent.
  the Prompt Memory API   answering the signed-in route: /enhance/stream
                          with per-request log ids and a running daily
                          count, /enhance/accept, and empty lists elsewhere.

Needs Playwright's bundled Chromium (branded Chrome ignores --load-extension):
    pip install playwright && python -m playwright install chromium
    python3 scripts/check_extension_e2e.py
"""
import ast
import json
import os
import sys
import tempfile
from pathlib import Path

# Lets context.route() see requests made by the extension's service worker.
os.environ.setdefault("PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS", "1")

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Playwright is not installed: pip install playwright")

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
checks = 0

ORIG = "hw do i sort a list of dicts by a key in python, some dont have the key"
SAVED = [
    {"id": "s1", "title": "Code review template", "tags": ["coding"],
     "content": "Review this diff like a senior engineer: correctness first, then naming, then tests."},
    {"id": "s2", "title": "Bug report triage", "tags": ["debug"],
     "content": "List the likely root causes ranked by probability and the log line that would confirm each."},
]
REPLY = {
    "deep": "Show me how to sort a list of dictionaries in Python by a specific key when some dictionaries lack it.",
    "quick": "How do I sort Python dicts by a key some of them lack?",
    "creative": "Explore the ways to sort Python dicts by a key that some lack, and when each would surprise me.",
}

CHAT = """<!doctype html><meta charset="utf-8"><title>ChatGPT</title>
<style>body{margin:0;height:100vh;background:#212121;color:#ddd;font:15px system-ui}
main{padding:40px;max-width:720px;margin:auto}form{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);
width:min(720px,90vw);background:#303030;border-radius:24px;padding:12px 16px;display:flex;gap:8px}
#prompt-textarea{flex:1;min-height:24px;outline:none}form>button{border-radius:50%;width:32px;height:32px}</style>
<main><p>How can I help you today?</p></main>
<form onsubmit="return false"><div id="prompt-textarea" contenteditable="true" role="textbox"></div><button type="button">↑</button></form>"""


def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        raise AssertionError(msg)


def router_modes():
    tree = ast.parse((ROOT / "backend/routers/prompts.py").read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "MODE_INSTRUCTIONS" for t in node.targets):
            return {k: v.strip() for k, v in ast.literal_eval(node.value).items()}
    raise RuntimeError("MODE_INSTRUCTIONS not found")


def main():
    modes = router_modes()
    requests, fail_next = [], {"on": False}

    def provider(route):
        body = json.loads(route.request.post_data or "{}")
        system = body["messages"][0]["content"]
        style = next((s for s in modes if f"### MODE: {s.upper()}" in system), "?")
        requests.append({"style": style, "system": system, "temperature": body.get("temperature")})
        if fail_next["on"]:
            fail_next["on"] = False
            route.fulfill(status=429, content_type="application/json",
                          body=json.dumps({"error": {"message": "Rate limit reached"}}))
            return
        text = REPLY.get(style, "?")
        chunks = [text[i:i + 12] for i in range(0, len(text), 12)]
        sse = "".join(f"data: {json.dumps({'choices': [{'delta': {'content': c}}]})}\n\n" for c in chunks)
        route.fulfill(status=200, content_type="text/event-stream", body=sse + "data: [DONE]\n\n")

    with sync_playwright() as p, tempfile.TemporaryDirectory() as profile:
        ctx = p.chromium.launch_persistent_context(
            profile, channel="chromium", headless=True, viewport={"width": 1440, "height": 900},
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
        )
        ctx.route("https://chatgpt.com/**", lambda r: r.fulfill(status=200, content_type="text/html", body=CHAT))
        ctx.route("https://api.groq.com/**", provider)
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        sw.evaluate("""chrome.storage.local.set({ byok_provider: 'groq', byok_key: 'gsk_test',
            byok_model: 'qwen/qwen3.8-27b', pm_data_consent_v1: true, pm_onboarded: true })""")

        page = ctx.new_page()
        errors = []
        # The stream's own "stream error" log is expected when a failure is simulated.
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Prompt Memory" in m.text
                and "stream error" not in m.text else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        def open_chat():
            page.goto("https://chatgpt.com/")
            page.wait_for_selector("#pm-trigger", state="attached", timeout=10000)
            page.wait_for_timeout(400)

        def title():
            return page.evaluate("(document.querySelector('#pm-card .pm-card-title')?.textContent || '').trim().toLowerCase()")

        def wait_title(text):
            try:
                page.wait_for_function(
                    "t => (document.querySelector('#pm-card .pm-card-title')?.textContent || '').trim().toLowerCase() === t",
                    arg=text.lower(), timeout=8000)
            except Exception:
                toasts = page.locator(".pm-toast").all_inner_texts()
                raise AssertionError(f"waited for {text!r}; card title {title()!r}, pill "
                                     f"{page.get_attribute('#pm-trigger', 'data-state')!r}, toasts {toasts}, "
                                     f"requests {[r['style'] for r in requests]}, errors {errors}") from None

        def type_prompt(text):
            page.click("#prompt-textarea")
            page.keyboard.press("Meta+A")
            page.keyboard.press("Backspace")
            page.keyboard.type(text)

        def last(style):
            r = requests[-1]
            check(r["style"] == style, f"expected a {style} request, got {r['style']}")
            check(r["system"].endswith(modes[style]), f"{style}: the provider did not get the server's exact instructions")
            check(r["temperature"] == {"quick": 0.5, "deep": 0.6, "creative": 0.7}[style], f"{style}: wrong temperature")

        open_chat()
        check(page.get_attribute("#pm-trigger", "data-state") == "idle", "pill starts idle")

        # First rewrite: the default style, through the real worker and provider call.
        type_prompt(ORIG)
        page.click("#pm-trigger")
        wait_title("Rewrite · Deep")
        last("deep")
        check(len(requests) == 1, "one provider call")

        # A failing rerun keeps the Deep draft.
        fail_next["on"] = True
        page.click("#pm-card-style-quick")
        page.wait_for_selector(".pm-toast:has-text('Quick version')", timeout=8000)
        wait_title("Rewrite · Deep")
        check(page.locator("#pm-card .pm-card-versions").count() == 0, "still one version after a failed rerun")

        # Shorter, then Open-ended: three versions, each with its own request.
        page.click("#pm-card-style-quick")
        wait_title("Rewrite · Quick")
        last("quick")
        check(page.text_content("#pm-card .pm-card-text").strip() == REPLY["quick"], "card shows the Quick reply")
        page.click("#pm-card-style-creative")
        wait_title("Rewrite · Creative")
        last("creative")
        check("3 of 3" in page.text_content("#pm-card .pm-card-versions"), "three versions")
        n = len(requests)
        page.click("#pm-card-style-deep")
        wait_title("Rewrite · Deep")
        check(len(requests) == n, "switching to a made version makes no provider call")

        # A reload restores the versions from the real chrome.storage.session.
        open_chat()
        wait_title("Rewrite · Deep")
        check("1 of 3" in page.text_content("#pm-card .pm-card-versions"), "versions and position survive a reload")

        # Insert writes the shown version; the draft must not return.
        page.click("#pm-card-style-quick")
        wait_title("Rewrite · Quick")
        page.click("#pm-card-accept")
        page.wait_for_function("document.getElementById('prompt-textarea').textContent.trim().length > 0")
        page.wait_for_timeout(400)
        check(page.text_content("#prompt-textarea").strip() == REPLY["quick"], "Insert wrote the Quick version")
        open_chat()
        page.wait_for_timeout(1500)
        check(page.locator("#pm-card").count() == 0 and page.get_attribute("#pm-trigger", "data-state") == "idle",
              "an inserted draft does not come back on reload (real session storage)")

        # Discard, the other path through closeCard(), must not come back either.
        type_prompt(ORIG)
        page.click("#pm-trigger")
        wait_title("Rewrite · Deep")
        page.click("#pm-card-discard")
        page.wait_for_timeout(300)
        open_chat()
        page.wait_for_timeout(1500)
        check(page.locator("#pm-card").count() == 0, "a discarded draft does not come back on reload")

        # Signed out, the library says where it lives; its ⋯ still sets the
        # default style, which is stored and used after a reload.
        page.keyboard.press("Meta+Shift+L")
        page.wait_for_selector("#pm-library:not([hidden])", timeout=5000)
        page.wait_for_selector("#pm-lib-signin", timeout=5000)
        check(True, "signed out: the library offers sign-in")
        page.click("#pm-lib-more")
        page.click("#pm-library [data-style='quick']")
        page.wait_for_timeout(200)
        check(sw.evaluate("chrome.storage.local.get('pm_mode').then(r => r.pm_mode)") == "quick", "default stored")
        check(page.get_attribute("#pm-library [data-style='quick']", "aria-pressed") == "true", "⋯ shows it")
        page.keyboard.press("Escape")
        page.keyboard.press("Escape")
        open_chat()
        type_prompt(ORIG)
        page.click("#pm-trigger")
        wait_title("Rewrite · Quick")
        last("quick")
        check([b.strip() for b in page.locator("#pm-card .pm-card-style").all_inner_texts()] == ["More detail", "Open-ended"],
              "a Quick first rewrite offers More detail and Open-ended")

        check(not errors, f"console errors: {errors}")
        page.click("#pm-card-discard")   # start the next phase with no draft pending

        # ── Signed in: the same flow through the server ──────────────────
        server = {"stream": [], "accept": [], "used": 12, "limit": 15, "fail_next": False}

        def api(route):
            req, path = route.request, route.request.url.split(".hf.space", 1)[1]
            if req.method == "POST" and path.startswith("/enhance/stream"):
                body = json.loads(req.post_data or "{}")
                server["stream"].append(body)
                if server["fail_next"]:
                    server["fail_next"] = False
                    events = [{"error": "provider_error", "detail": "The model is overloaded."},
                              {"done": True, "failed": True, "mode": body["mode"]}]
                else:
                    server["used"] += 1
                    text = REPLY[body["mode"]]
                    events = [{"token": text[i:i + 12]} for i in range(0, len(text), 12)]
                    events.append({"done": True, "failed": False, "log_id": f"log-{len(server['stream'])}",
                                   "latency": 0.4, "mode": body["mode"], "model": "fake",
                                   "usage_today": {"used": server["used"], "limit": server["limit"], "tier": "free"},
                                   "context_used": {"selected": 0, "auto_matched": 0, "passive_matched": 0}})
                route.fulfill(status=200, content_type="text/event-stream",
                              body="".join(f"data: {json.dumps(e)}\n\n" for e in events))
            elif req.method == "POST" and path.startswith("/enhance/accept"):
                server["accept"].append(json.loads(req.post_data or "{}"))
                route.fulfill(status=200, content_type="application/json", body="{}")
            elif req.method == "GET" and path.startswith("/saved-prompts"):
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"prompts": SAVED}))
            elif req.method == "GET" and path.startswith("/enhance/usage"):
                route.fulfill(status=200, content_type="application/json",
                              body=json.dumps({"count": server["used"], "limit": server["limit"]}))
            else:
                route.fulfill(status=200, content_type="application/json", body="[]" if req.method == "GET" else "{}")

        ctx.route("https://siddhm11-prompt-engine.hf.space/**", api)
        # A token that does not expire until 2100, and no key of their own.
        jwt = "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6InUxIn0.x"
        sw.evaluate(f"""chrome.storage.local.remove(['byok_key']).then(() =>
            chrome.storage.local.set({{ token: '{jwt}', user_id: 'u1', email: 'u@example.com', pm_mode: 'deep' }}))""")
        check(sw.evaluate("chrome.storage.local.get(['token']).then(r => !!r.token)"), "signed in")
        n_provider = len(requests)

        open_chat()
        type_prompt(ORIG)
        page.click("#pm-trigger")
        wait_title("Rewrite · Deep")
        check(len(server["stream"]) == 1 and server["stream"][0]["mode"] == "deep", "the server got a Deep request")
        check(server["stream"][0]["prompt"] == ORIG, "the server got the typed prompt")
        check("byok_key" not in server["stream"][0], "no key rides along when the user has none")
        check(len(requests) == n_provider, "the signed-in route never calls the provider directly")
        check([b.strip() for b in page.locator("#pm-card .pm-card-style").all_inner_texts()]
              == ["Shorter · 2 left", "Open-ended · 2 left"],
              f"the server's daily count shows on the buttons, got {page.locator('#pm-card .pm-card-style').all_inner_texts()}")

        # A rerun the server fails keeps the draft and spends nothing.
        server["fail_next"] = True
        page.click("#pm-card-style-quick")
        page.wait_for_selector(".pm-toast:has-text('Quick version')", timeout=8000)
        wait_title("Rewrite · Deep")
        check("overloaded" in " ".join(page.locator(".pm-toast").all_inner_texts()), "the server's reason is shown")

        page.click("#pm-card-style-quick")
        wait_title("Rewrite · Quick")
        last_req = server["stream"][-1]
        check(last_req["mode"] == "quick" and last_req["prompt"] == ORIG, "Shorter asked the server for Quick, same prompt")
        check([b.strip() for b in page.locator("#pm-card .pm-card-style").all_inner_texts()]
              == ["More detail", "Open-ended · 1 left"], "the made style is free; the other shows 1 left")

        # Insert approves the version shown, not the first one.
        page.click("#pm-card-accept")
        page.wait_for_function("document.getElementById('prompt-textarea').textContent.trim().length > 0")
        page.wait_for_timeout(500)
        check(page.text_content("#prompt-textarea").strip() == REPLY["quick"], "Insert wrote the Quick version")
        check([a.get("log_id") for a in server["accept"]] == [f"log-{len(server['stream'])}"],
              f"only the inserted version is approved, got {server['accept']}")

        # The last rewrite of the day: the buttons stop, and no request is sent.
        server["used"] = 14
        type_prompt(ORIG + " again")
        # For six seconds after an Insert the pill is an "Inserted" receipt, and
        # a click on it only dismisses that (by design); then it enhances.
        if page.get_attribute("#pm-trigger", "data-state") == "applied":
            page.click("#pm-trigger")
        page.click("#pm-trigger")
        wait_title("Rewrite · Deep")
        check(page.get_attribute("#pm-card-style-quick", "aria-disabled") == "true", "no rewrites left: disabled")
        before = len(server["stream"])
        page.click("#pm-card-style-quick", force=True)
        page.wait_for_selector(".pm-toast:has-text('No rewrites left')", timeout=5000)
        check(len(server["stream"]) == before, "a spent allowance sends nothing")
        page.click("#pm-card-discard")

        # ── The library, signed in, in the real extension ────────────────
        server["used"] = 3
        open_chat()
        # Opened the way a person does: hover ⊕, drift across the gap to the
        # Library chip, click. The chip used to fade from under the pointer.
        pbox = page.locator("#pm-trigger").bounding_box()
        px, py = pbox["x"] + pbox["width"] / 2, pbox["y"] + pbox["height"] / 2
        page.mouse.move(px, py)
        page.wait_for_timeout(250)
        cbox = page.locator("#pm-library-btn").bounding_box()
        cx, cy = cbox["x"] + cbox["width"] / 2, cbox["y"] + cbox["height"] / 2
        for i in range(1, 13):
            page.mouse.move(px + (cx - px) * i / 12, py + (cy - py) * i / 12)
            page.wait_for_timeout(30)
        page.mouse.down()
        page.mouse.up()
        page.wait_for_selector("#pm-library .pm-lib-row", timeout=8000)
        check(True, "hover ⊕, move to the chip, click: the library opens")
        titles = [x.strip() for x in page.locator("#pm-library .pm-lib-row .pm-lib-title").all_inner_texts()]
        check(titles == ["Code review template", "Bug report triage"], f"saved prompts from the server, got {titles}")
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Meta+Enter")
        page.wait_for_selector("#pm-rail .pm-rail-chip", timeout=5000)
        check("Bug report triage" in page.text_content("#pm-rail"), "attached: named on the rail")
        page.keyboard.press("Escape")

        # The attachment survives a reload (real chrome.storage.session) and rides with the rewrite.
        open_chat()
        page.wait_for_selector("#pm-rail .pm-rail-chip", timeout=5000)
        check("Bug report triage" in page.text_content("#pm-rail"), "the rail survives a reload")
        type_prompt(ORIG)
        page.click("#pm-trigger")
        wait_title("Rewrite · Deep")
        check(server["stream"][-1].get("selected_prompt_ids") == ["s2"],
              f"the rewrite carries the attached prompt, got {server['stream'][-1].get('selected_prompt_ids')}")
        page.click("#pm-card-discard")

        # // in a ChatGPT-style editor: insert at the caret; Enter must not reach the host.
        page.evaluate("window.__sent = 0; document.getElementById('prompt-textarea').addEventListener('keydown', "
                      "e => { if (e.key === 'Enter' && !e.defaultPrevented) window.__sent++; })")
        type_prompt("Before I merge, can you ")
        page.keyboard.type("//rev")
        page.wait_for_selector("#pm-caret .pm-caret-row", timeout=5000)
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        box = page.text_content("#prompt-textarea")
        check(box.startswith("Before I merge, can you Review this diff") and "//rev" not in box,
              f"// inserts at the caret in the real extension, got {box!r}")
        check(page.evaluate("window.__sent") == 0, "the Enter that picked the prompt never reached the host")
        # Tab attaches from // and removes the query.
        type_prompt("Look at ")
        page.keyboard.type("//code")
        page.wait_for_selector("#pm-caret .pm-caret-row", timeout=5000)
        page.keyboard.press("Tab")
        page.wait_for_timeout(300)
        check("//code" not in page.text_content("#prompt-textarea"), "⇥ removes the //query")
        check(page.locator("#pm-rail .pm-rail-chip").count() == 2, "and attaches: two on the rail")
        # The token refreshes itself every few days for the same user: that must not touch them.
        sw.evaluate("chrome.storage.local.set({ token: 'eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDEsInN1YiI6InUxIn0.y', user_id: 'u1' })")
        page.wait_for_timeout(400)
        check(page.locator("#pm-rail .pm-rail-chip").count() == 2, "a token refresh keeps the attachments")
        # Clear from the sheet.
        page.keyboard.press("Meta+Shift+L")
        page.wait_for_selector("#pm-library .pm-lib-link", timeout=5000)
        page.click("#pm-library .pm-lib-link")
        page.wait_for_timeout(200)
        check(page.locator("#pm-rail").count() == 0, "Clear detaches everything")
        page.keyboard.press("Escape")
        # Signing out forgets them.
        type_prompt("x ")
        page.keyboard.type("//bug")
        page.wait_for_selector("#pm-caret .pm-caret-row", timeout=5000)
        page.keyboard.press("Tab")
        page.wait_for_selector("#pm-rail .pm-rail-chip", timeout=5000)
        sw.evaluate("chrome.storage.local.remove(['token', 'user_id', 'email'])")
        page.wait_for_timeout(400)
        check(page.locator("#pm-rail").count() == 0, "signing out clears the attachments")

        check(not errors, f"console errors: {errors}")
        ctx.close()
    print(f"{checks} end-to-end checks PASS ({len(requests)} provider requests, "
          f"{len(server['stream'])} server requests)")


if __name__ == "__main__":
    main()
