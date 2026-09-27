"""Drive the real content.js through the library in Chrome.

Uses extension/tests/pill-harness.html: its FAKE_API answers the Prompt Memory
server (saved prompts, history, usage, feedback) and logs every call. Checks
the sheet on the pill, // at the caret, and the rail of attached prompts:
what the user sees, what lands in the chat box, what is sent to the server,
and what survives a reload.

    pip install playwright
    python3 scripts/check_library.py [--shots DIR]
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_card_styles import serve  # noqa: E402  (same quiet local server)

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Playwright is not installed: pip install playwright")

checks = 0


def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        raise AssertionError(msg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", help="directory for screenshots")
    args = ap.parse_args()
    httpd = serve()
    url = f"http://127.0.0.1:{httpd.server_port}/extension/tests/pill-harness.html"

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        ev = page.evaluate

        def load():
            page.goto(url)
            page.wait_for_function("document.getElementById('pm-trigger') && document.getElementById('pm-library')")
            page.wait_for_timeout(300)

        def shot(name):
            if args.shots:
                Path(args.shots).mkdir(parents=True, exist_ok=True)
                page.wait_for_timeout(350)   # let the 150ms open animation finish
                page.screenshot(path=str(Path(args.shots) / f"{name}.png"))

        def open_lib():
            page.keyboard.press("Meta+Shift+L")
            page.wait_for_selector("#pm-library:not([hidden])")
            page.wait_for_function("!document.querySelector('#pm-library .pm-lib-skeleton')")

        def rows():
            return [t.strip() for t in page.locator("#pm-library .pm-lib-row .pm-lib-title").all_inner_texts()]

        def composer():
            return ev("document.getElementById('composer').textContent")

        def set_box(text):
            """Type into the mock chat box with the caret at the end, as a user would."""
            ev("""t => { const c = document.getElementById('composer'); c.focus(); c.textContent = t;
                   const r = document.createRange(); r.selectNodeContents(c); r.collapse(false);
                   const s = getSelection(); s.removeAllRanges(); s.addRange(r);
                   c.dispatchEvent(new InputEvent('input', { bubbles: true })); }""", text)

        def calls(method, path):
            return ev(f"FAKE_API.calls.filter(c => c.method === '{method}' && c.path.startsWith('{path}'))")

        def rect(sel):
            return ev(f"(() => {{ const r = document.querySelector('{sel}')?.getBoundingClientRect(); return r && {{ l: r.left, t: r.top, r: r.right, b: r.bottom }}; }})()")

        def overlaps(a, b):
            return a and b and a["l"] < b["r"] and a["r"] > b["l"] and a["t"] < b["b"] and a["b"] > b["t"]

        load()
        ev("localStorage.clear(); sessionStorage.clear()")
        load()

        # ── signed out ──
        open_lib()
        check(ev("document.getElementById('pm-library').dataset.page") == "signin", "signed out: the sign-in page")
        check(page.locator("#pm-lib-signin").count() == 1, "with a Sign in button")
        check(page.locator("#pm-lib-more").count() == 1, "and ⋯ still there (style, voice, privacy work without an account)")
        page.keyboard.press("Escape")
        set_box("hello ")
        page.keyboard.type("//rev")
        check(page.locator("#pm-caret").count() == 0, "signed out: // is just text")

        # ── signed in ──
        ev("localStorage.clear(); sessionStorage.clear(); H.signIn()")
        load()
        page.hover("#pm-trigger")
        page.wait_for_timeout(250)
        chip = page.inner_text("#pm-library-btn").strip()
        check(chip == "Library" and "☰" not in chip, f"the chip is drawn, not a typed ☰, got {chip!r}")
        check(page.locator("#pm-library-btn svg").count() == 1, "chip icon is an SVG")
        page.click("#pm-library-btn")
        page.wait_for_selector("#pm-library:not([hidden])")
        page.wait_for_function("!document.querySelector('#pm-library .pm-lib-skeleton')")
        check(page.get_attribute("#pm-library-btn", "aria-expanded") == "true", "chip reports the sheet open")
        check(ev("document.activeElement.id") == "pm-lib-q", "search has focus on open")
        check(rows() == ["Code review template", "You are my writing editor", "Explain like a teacher",
                         "Bug report triage", "Product spec critic"], f"saved prompts listed, got {rows()}")
        previews = page.locator("#pm-library .pm-lib-row .pm-lib-preview").all_inner_texts()
        check(previews[1].startswith("Cut every sentence"), f"untitled prompt's preview skips its title, got {previews[1]!r}")
        check(page.get_attribute("#pm-lib-q", "placeholder") == "Search 5 saved prompts", "placeholder counts prompts")
        lib, box, send = rect("#pm-library"), rect("form"), rect(".send")
        check(not overlaps(lib, send), "the sheet stays off the chat box's send button")
        check(not overlaps(lib, box), "and off the chat box itself at 1440×900")
        check(lib["t"] >= 0 and lib["r"] <= 1440, "and inside the window")
        check(len(calls("GET", "/saved-prompts")) == 1, "one fetch of saved prompts")
        shot("1-open")

        # search and keys
        page.keyboard.type("bug")
        check(rows() == ["Bug report triage"], f"search by text, got {rows()}")
        page.fill("#pm-lib-q", "#writ")
        check(rows() == ["You are my writing editor"], f"#tag search, got {rows()}")
        page.fill("#pm-lib-q", "zzz")
        check("Nothing matches" in page.inner_text("#pm-library .pm-lib-list"), "no-match message")
        page.fill("#pm-lib-q", "")
        page.keyboard.press("ArrowDown")
        active = page.get_attribute("#pm-lib-q", "aria-activedescendant")
        check(active == "pm-lib-row-1", f"↓ moves the highlight (aria-activedescendant), got {active}")
        page.keyboard.press("ArrowUp")
        page.keyboard.press("ArrowUp")
        check(page.get_attribute("#pm-lib-q", "aria-activedescendant") == "pm-lib-row-4", "↑ wraps to the last row")

        # attach with ⌘↵
        page.keyboard.press("ArrowDown")          # wraps back to the first row
        page.keyboard.press("Meta+Enter")
        check(page.locator("#pm-rail .pm-rail-chip").count() == 1, "⌘↵ attaches: a chip on the rail")
        check(page.inner_text("#pm-rail .pm-rail-chip").strip() == "Code review template", f"the rail names it, got {page.inner_text('#pm-rail .pm-rail-chip')!r} {ev('[...selectedIds]')}")
        check("1 attached as context" in page.inner_text("#pm-lib-foot"), "the foot says so")
        check(ev("[...selectedIds]") == ["p1"], "selected for the next rewrite")
        check(ev("JSON.parse(sessionStorage.getItem('pm')).pm_attached")[0]["title"] == "Code review template",
              "kept in session storage with its title")
        shot("2-attached")

        # insert into an empty box
        page.keyboard.press("ArrowDown")
        page.keyboard.press("ArrowDown")
        check(page.inner_text("#pm-library .pm-lib-row.pm-sel .pm-lib-verb").strip() == "Insert", "empty box: Insert")
        page.keyboard.press("Enter")
        page.wait_for_selector("#pm-library", state="hidden")
        # Insert gives the editor a frame to see the selection before clearing.
        page.wait_for_function("document.getElementById('composer').textContent.length > 0", timeout=3000)
        check(composer().startswith("Explain the concept step by step"), f"inserted, got {composer()!r}")
        page.wait_for_function("document.getElementById('pm-trigger').dataset.state === 'applied'", timeout=3000)
        check(True, "the pill says Inserted once the write is verified")

        # a half-written box: Replace, and the Save row
        set_box("Turn these meeting notes into action items with owners")
        page.click("#pm-trigger")        # dismiss the Inserted receipt first
        open_lib()
        check(rows()[0].startswith("Save “Turn these meeting notes"), f"the box offered as a Save row, got {rows()[0]!r}")
        verb = ev("document.querySelectorAll('#pm-library .pm-lib-row')[1].querySelector('.pm-lib-verb').textContent")
        check(verb == "Replace", f"box has text: Replace, got {verb!r}")
        page.keyboard.press("Enter")
        page.wait_for_function("FAKE_API.calls.some(c => c.method === 'POST' && c.path === '/saved-prompts')")
        page.wait_for_function("!document.querySelector('#pm-library .pm-lib-row-save') && "
                               "document.querySelectorAll('#pm-library .pm-lib-row').length === 6")
        check("Turn these meeting notes" in rows()[0], f"saved and listed first, got {rows()[:2]}")
        check(not any(r.startswith("Save “") for r in rows()), "the Save row goes once saved")

        # delete, with an inline confirm
        page.fill("#pm-lib-q", "spec")
        page.hover("#pm-library .pm-lib-row")
        page.click("#pm-library .pm-lib-row [data-act='more']")
        page.click("#pm-library [data-act='ask']")
        check("Delete “Product spec critic”?" in page.inner_text("#pm-library .pm-lib-confirm"), "asks first")
        page.click("#pm-library [data-act='keepit']")
        check(rows() == ["Product spec critic"], "Keep keeps it")
        page.hover("#pm-library .pm-lib-row")
        page.click("#pm-library .pm-lib-row [data-act='more']")
        page.click("#pm-library [data-act='ask']")
        page.click("#pm-lib-del")
        page.wait_for_function("FAKE_API.calls.some(c => c.method === 'DELETE')")
        page.wait_for_timeout(200)
        check(calls("DELETE", "/saved-prompts/p5"), "DELETE sent")
        check(rows() == [] or "Product spec critic" not in rows(), "and it is gone")
        page.fill("#pm-lib-q", "")

        # History (it was "Recent", which read as "recently saved")
        check([t.strip() for t in page.locator("#pm-library .pm-lib-views button").all_inner_texts()] == ["Saved", "History"],
              "the two lists are Saved and History")
        page.click("#pm-lib-view-recent")
        page.wait_for_function("document.querySelectorAll('#pm-library .pm-lib-row').length === 2")
        check(page.get_attribute("#pm-lib-q", "placeholder") == "Search your rewrite history", "History says what it holds")
        check(rows()[0].startswith("Show me how to sort"), f"past rewrites listed, got {rows()}")
        check("from “hw do i sort" in page.inner_text("#pm-library .pm-lib-row .pm-lib-preview"), "with what they came from")
        page.keyboard.press("Enter")
        page.wait_for_selector("#pm-library", state="hidden")
        page.wait_for_function("document.getElementById('composer').textContent.startsWith('Show me how to sort')", timeout=3000)
        check(composer().startswith("Show me how to sort"), "a recent rewrite inserts")
        page.wait_for_function("FAKE_API.calls.some(c => c.path === '/enhance/accept')")
        check(calls("POST", "/enhance/accept")[0]["body"]["log_id"] == "h1", "and is approved by its log id")

        # ⋯: default style, count, privacy, feedback
        page.click("#pm-trigger")
        open_lib()
        page.click("#pm-lib-more")
        check("9 of 15 rewrites used today" in page.inner_text("#pm-library .pm-lib-menu"), "⋯ shows today's count")
        page.click("#pm-library [data-style='quick']")
        check(ev("currentMode") == "quick" and ev("JSON.parse(localStorage.getItem('pm')).pm_mode") == "quick",
              "⋯ sets and stores the default style")
        check(page.get_attribute("#pm-library [data-style='quick']", "aria-pressed") == "true", "and shows it")
        page.click("#pm-library [data-style='deep']")
        page.click("#pm-library [data-act='privacy']")
        check(ev("document.getElementById('pm-library').dataset.page") == "privacy", "privacy page")
        check(not page.is_checked("#pm-tracking-toggle") and page.is_checked("#pm-context-toggle") and page.is_checked("#pm-slash-toggle"),
              "switches show the current settings: tracking starts off, as the privacy policy says")
        check(ev("promptTrackingEnabled") is False, "and nothing is tracked until it is turned on")
        page.click("#pm-tracking-toggle")
        check(ev("JSON.parse(localStorage.getItem('pm')).pm_tracking") is True and ev("promptTrackingEnabled") is True,
              "tracking on is stored and applied")
        page.click("#pm-tracking-toggle")
        check(ev("JSON.parse(localStorage.getItem('pm')).pm_tracking") is False and ev("promptTrackingEnabled") is False,
              "and off again")
        page.keyboard.press("Escape")
        check(ev("document.getElementById('pm-library').dataset.page") == "list", "esc on a page goes back to the list")
        page.click("#pm-lib-more")
        page.click("#pm-library [data-act='feedback']")
        page.click("#pm-feedback-submit")
        check("few words" in page.inner_text("#pm-feedback-status"), "empty feedback is refused")
        page.fill("#pm-feedback-message", "The new library is easier to use.")
        page.click("#pm-feedback-submit")
        page.wait_for_function("document.getElementById('pm-feedback-status')?.textContent.includes('Sent')")
        check(calls("POST", "/feedback")[0]["body"]["message"] == "The new library is easier to use.", "feedback sent")
        page.click("#pm-lib-back")

        # closing
        page.keyboard.press("Escape")
        page.wait_for_selector("#pm-library", state="hidden")
        check(ev("document.activeElement.id") == "composer", "esc returns the keyboard to the chat box")
        open_lib()
        page.mouse.click(700, 200)
        page.wait_for_selector("#pm-library", state="hidden")
        check(True, "a click elsewhere closes it")

        # a low daily allowance shows in the foot
        ev("FAKE_API.usage = { count: 13, limit: 15 }")
        ev("clearAttachments()")
        open_lib()
        page.wait_for_function("document.getElementById('pm-lib-foot')?.textContent.includes('left today')")
        check("2 rewrites left today" in page.inner_text("#pm-lib-foot"), "the foot warns at three or fewer")
        page.keyboard.press("Escape")

        # ── // at the caret ──
        set_box("Before I merge, can you ")
        page.keyboard.type("//rev")
        page.wait_for_selector("#pm-caret")
        check([t.strip() for t in page.locator("#pm-caret .pm-lib-title").all_inner_texts()] == ["Code review template"],
              "//rev filters to the matching prompt")
        shot("3-slash")
        page.keyboard.press("Enter")
        page.wait_for_timeout(200)
        check(composer() == "Before I merge, can you Review this diff like a senior engineer: correctness first, then naming, "
                             "then tests. Flag anything that changes behaviour.", f"↵ inserts where // was, got {composer()!r}")
        check(page.locator("#pm-caret").count() == 0, "and closes")

        set_box("Please look at ")
        page.keyboard.type("//bug")
        page.wait_for_selector("#pm-caret")
        page.keyboard.press("Tab")
        page.wait_for_timeout(150)
        check(composer().strip() == "Please look at", f"⇥ attaches and drops the //query, got {composer()!r}")
        check("Bug report triage" in page.inner_text("#pm-rail"), "the rail names what ⇥ attached")

        set_box("hmm ")
        page.keyboard.type("//exp")
        page.wait_for_selector("#pm-caret")
        page.keyboard.press("Escape")
        check(page.locator("#pm-caret").count() == 0 and composer() == "hmm //exp", "esc closes and leaves the text alone")
        page.keyboard.type("l")
        check(page.locator("#pm-caret").count() == 0, "and stays shut while that // is still being typed")

        for text in ["see https://example.com/a", "a//b and c//d"]:
            set_box("")
            opened = False
            for ch in text:
                page.keyboard.type(ch)
                opened = opened or page.locator("#pm-caret").count() > 0
            check(not opened, f"{text!r} never opens the menu")

        set_box("x ")
        page.keyboard.type("//zzzz")
        page.wait_for_selector("#pm-caret")
        check("No saved prompt matches" in page.inner_text("#pm-caret"), "no match is said")
        prevented = ev("""(() => { const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
                          document.getElementById('composer').dispatchEvent(e); return e.defaultPrevented; })()""")
        check(prevented is False and page.locator("#pm-caret").count() == 0, "with nothing to pick, Enter is the host's (sends)")

        # ── the rail ──
        set_box("")
        page.wait_for_selector("#pm-rail:not([hidden])")
        rail, frame = rect("#pm-rail"), rect("form")
        check(rail["b"] <= frame["t"], f"the rail sits above the chat box's frame, not on it ({rail['b']} vs {frame['t']})")
        load()
        page.wait_for_selector("#pm-rail:not([hidden])")
        check("Bug report triage" in page.inner_text("#pm-rail"), "attachments survive a reload")
        ev("H.type(H.ORIG)")
        page.click("#pm-trigger")
        page.wait_for_function("cardState === 'ready'")
        page.wait_for_timeout(100)
        check(ev("document.getElementById('pm-rail').hidden") is True, "the rail steps aside for the card")
        page.click("#pm-card-min")
        page.wait_for_timeout(250)
        check(ev("document.getElementById('pm-rail').hidden") is False, "and returns when the card folds")
        ev("closeCard()")
        page.click("#pm-rail [data-act='railadd']")
        page.wait_for_selector("#pm-library:not([hidden])")
        check(True, "+ Context opens the library")
        page.keyboard.press("Escape")
        page.click("#pm-rail .pm-rail-chip button")
        check(page.locator("#pm-rail").count() == 0 and ev("selectedIds.size") == 0, "× on the chip detaches")

        # a deleted prompt is dropped from the attachments
        ev("toggleAttachment(savedPrompts.find(p => p.id === 'p4'))")
        ev("FAKE_API.prompts = FAKE_API.prompts.filter(p => p.id !== 'p4')")
        open_lib()
        page.wait_for_function("selectedIds.size === 0")
        check(page.locator("#pm-rail").count() == 0, "attachments whose prompt was deleted are forgotten")
        page.keyboard.press("Escape")

        if args.shots:
            page.click("text=light")
            ev("toggleAttachment(savedPrompts[0])")
            open_lib()
            shot("4-light-host")
            page.keyboard.press("Escape")
            page.click("text=light")
            ev("clearAttachments()")

        # ── a hostile host page ──
        ev("""document.head.insertAdjacentHTML('beforeend',
              '<style>button{width:32px!important;padding:0!important}input{border:3px solid red}</style>')""")
        page.hover("#pm-trigger")
        page.wait_for_timeout(250)
        w = ev("document.getElementById('pm-library-btn').getBoundingClientRect().width")
        check(w > 60, f"the chip keeps its size against host button rules, got {w}px")
        stack = ev("document.elementsFromPoint(1408, 860).map(e => e.id || e.tagName)[0]")
        check(stack in ("path", "svg", "SPAN", "pm-trigger"), f"⊕ stays clickable, top element {stack}")

        check(not errors, f"page errors: {errors}")
        page.close()
        reach_the_chip_from_anywhere(browser, url)
        browser.close()
    httpd.shutdown()
    print(f"{checks} library checks PASS")


def reach_the_chip_from_anywhere(browser, url):
    """Hover ⊕, drift to the Library chip the way a hand does, click: the
    library must open wherever the pill is. The chip used to be revealed by a
    CSS :hover on ⊕, lost in the gap on the way over; this walks the pill
    through every dock, height, layout and width the chip's placement varies
    with, and approaches along a curved path that overshoots and comes back."""
    cases = 0
    for vw, vh in [(1440, 900), (1280, 720), (800, 600)]:
        page = browser.new_page(viewport={"width": vw, "height": vh})
        page.goto(url)
        page.wait_for_timeout(400)
        page.evaluate("localStorage.clear(); sessionStorage.clear(); H.signIn()")
        page.goto(url)
        page.wait_for_function("document.getElementById('pm-library')")
        page.wait_for_timeout(400)
        for layout in ("chat", "new-chat"):
            for draft in (False, True):
                for dock in ("right", "left"):
                    for bottom in (24, vh // 2 - 40, vh - 90):
                        page.mouse.move(5, 5)
                        page.evaluate("""([layout, draft, dock, bottom]) => {
                            togglePanel(false); closeCard();
                            document.body.classList.toggle('center', layout === 'new-chat');
                            if (draft) { H.type(H.ORIG); H.stream(); H.done(); hideCard(); } else { H.type(''); }
                            pillDock = dock; pillBottom = bottom; placePill();
                        }""", [layout, draft, dock, bottom])
                        page.wait_for_timeout(450)          # the chip's grace period runs out
                        where = f"{vw}x{vh} {layout} {'draft' if draft else 'idle'} dock-{dock} bottom-{bottom}"
                        box = lambda sel: page.evaluate(
                            f"(() => {{ const r = document.querySelector('{sel}').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }})()")
                        px, py = box("#pm-trigger")
                        page.mouse.move(px, py)
                        page.wait_for_timeout(200)
                        if page.evaluate("document.getElementById('pm-library-btn').hidden"):
                            continue                         # nowhere clear of the chat box: ⇧-click and ⌘⇧L remain
                        cx, cy = box("#pm-library-btn")
                        # A curved path that overshoots the chip and comes back, ~30 ms a step.
                        for i in range(1, 15):
                            f = i / 12
                            page.mouse.move(px + (cx - px) * f, py + (cy - py) * f + 14 * (f - f * f))
                            page.wait_for_timeout(30)
                        page.mouse.move(cx, cy)
                        page.wait_for_timeout(60)
                        page.mouse.down()
                        page.mouse.up()
                        page.wait_for_timeout(150)
                        check(page.evaluate("!document.getElementById('pm-library').hidden"),
                              f"{where}: hovering ⊕ then clicking the chip opens the library")
                        # It stays open with the pointer gone, and clicks inside it keep it open.
                        page.mouse.move(vw // 2, 30)
                        page.wait_for_timeout(500)
                        check(page.evaluate("!document.getElementById('pm-library').hidden"),
                              f"{where}: the library stays open when the pointer leaves")
                        head = page.evaluate("(() => { const r = document.querySelector('#pm-library .pm-lib-head').getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; })()")
                        page.mouse.click(*head)
                        page.wait_for_timeout(100)
                        check(page.evaluate("!document.getElementById('pm-library').hidden"),
                              f"{where}: a click inside the library keeps it open")
                        page.keyboard.press("Escape")
                        page.mouse.move(5, vh // 2)
                        page.wait_for_timeout(700)
                        check(page.evaluate("getComputedStyle(document.getElementById('pm-library-btn')).opacity") == "0",
                              f"{where}: the chip goes away once the pointer has left both")
                        cases += 1
        page.close()
    check(cases >= 60, f"only {cases} placements were reachable to test")
    print(f"chip reached from {cases} pill placements")


if __name__ == "__main__":
    main()
