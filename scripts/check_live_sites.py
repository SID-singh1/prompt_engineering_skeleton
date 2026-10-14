"""Load the real extension on the real chat sites, logged out, and check it still finds them.

Faked pages cannot catch a site changing its own markup, and twice in one week
of October 2026 one did. For each site this loads the unpacked extension,
opens the site logged out, types a draft into the site's own chat box, and
checks what a person would see:

  - the pill is on the page (the content script ran there)
  - the draft turns it into "⊕ Improve" (the chat box was found and is watched)
  - a rewrite streams into the card (the model's reply is faked: api.groq.com
    is routed, so no quota is spent and no key is needed)
  - Replace writes the rewrite into the site's chat box

Nothing is ever sent: Enter is not pressed, and the tab is closed after.

Needs the network and Playwright's own Chromium (python -m playwright install
chromium). Headless by default. Some sites show a bot check to a headless
browser; pass --headed for those (a browser window opens while it runs). Claude
needs a login: pass --profile DIR, a Chromium profile signed in to claude.ai,
to include it. A site behind a bot check or a login wall is reported as
skipped, not failed: it says nothing about the extension.

    python3 scripts/check_live_sites.py [--headed] [--only chatgpt,gemini] [--profile DIR] [--shots DIR]

Exit status is 1 if any site that loaded failed a check.
"""
import argparse
import json
import re
import shutil
import sys
import tempfile
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("Playwright is not installed: pip install playwright && python -m playwright install chromium")

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
SITES = [
    ("chatgpt", "https://chatgpt.com/"),
    ("gemini", "https://gemini.google.com/app"),
    ("perplexity", "https://www.perplexity.ai/"),
    ("grok", "https://grok.com/"),
    ("claude", "https://claude.ai/new"),
]
DRAFT = "help me write a short email to my landlord about a leak in the kitchen"
REPLY = "Write a polite, short email to my landlord reporting a kitchen leak and asking for a repair date this week."
WALLS = re.compile(r"just a moment|verify you are human|attention required|checking your browser|log in|sign in|sign up", re.I)


def composer_selectors():
    """The chat box's selectors, read from sites.js: the same list the extension uses."""
    src = (EXT / "sites.js").read_text(encoding="utf-8")
    block = src[src.index("composer: Object.freeze(["):src.index("]),", src.index("composer: Object.freeze(["))]
    return re.findall(r'"([^"]+)"', block)


# A cookie notice can sit over the page's corner at the top of the stacking
# order (seen: z-index 2147483647 over the pill), as it does for a first-time
# visitor. It is answered as a person would, refusing what can be refused.
COOKIE_BUTTONS = re.compile(r"^(reject|decline|refuse|necessary only|only necessary|reject all|reject non-essential|"
                            r"accept all cookies|accept all|accept|got it|ok)$", re.I)


def dismiss_cookie_notice(page):
    """Click the notice's refuse (else accept) button, if a cookie notice is up."""
    buttons = page.locator("[role='dialog'] button, [class*='cookie' i] button, [id*='cookie' i] button, [data-cookie-banner] button")
    best = None
    for i in range(min(buttons.count(), 20)):
        b = buttons.nth(i)
        try:
            label = b.inner_text(timeout=500).strip()
        except Exception:
            continue
        if COOKIE_BUTTONS.match(label):
            if re.match(r"^(reject|decline|refuse|necessary|only)", label, re.I):
                best = b
                break
            best = best or b
    if best:
        try:
            best.click(timeout=2000)
            page.wait_for_timeout(600)
            return True
        except Exception:
            return False
    return False


FAKE_STREAM = "".join(
    f"data: {json.dumps({'choices': [{'delta': {'content': REPLY[i:i + 14]}}]})}\n\n" for i in range(0, len(REPLY), 14)
) + "data: [DONE]\n\n"


def click_through_notices(page, target, notes):
    """Click target; a cookie notice that arrived late and covers it is answered and the click tried again."""
    try:
        page.locator(target).click(timeout=4000)
        return None
    except Exception as first:
        if dismiss_cookie_notice(page):
            notes.append("a late cookie notice answered")
            try:
                page.locator(target).click(timeout=4000)
                return None
            except Exception as second:
                return str(second).splitlines()[0]
        return str(first).splitlines()[0]


def check_site(ctx, name, url, selectors, shots):
    """One site: returns (status, notes). status is pass, fail or skipped."""
    page = ctx.new_page()
    notes = []
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Prompt Memory" in m.text else None)

    def shot(step):
        if shots:
            Path(shots).mkdir(parents=True, exist_ok=True)
            page.wait_for_timeout(600)   # past the card's and the pill's transitions
            page.screenshot(path=str(Path(shots) / f"{name}-{step}.png"))

    try:
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
        except Exception as exc:
            return "skipped", [f"did not load: {exc.__class__.__name__}"]
        page.wait_for_timeout(4000)
        if dismiss_cookie_notice(page):
            notes.append("cookie notice answered")
        shot("0-loaded")
        pill = page.locator("#pm-trigger")
        if pill.count() == 0:
            title = page.title()
            if WALLS.search(title) or WALLS.search(page.inner_text("body")[:600] if page.locator("body").count() else ""):
                return "skipped", [f"a bot check or login wall: {title!r}"]
            return "fail", ["no pill: the content script did not run, or ran and failed"] + errors[:2]
        notes.append("pill loaded")
        # Cloudflare's check: its title is "Just a moment...", and its widget's
        # words are in an iframe or shadow root, not the page's text.
        if re.search(r"just a moment|attention required", page.title(), re.I) or page.locator(
                "iframe[src*='challenges.cloudflare.com'], #challenge-form, .cf-turnstile, [id^='cf-chl-widget'], "
                "[name='cf-turnstile-response']").count():
            shot("0-wall")
            return "skipped", notes + ["Cloudflare's bot check (try --headed)"]

        # The site's chat box, by the extension's own selectors, first visible
        # one. Waited for: these pages keep building after they load.
        box = None
        for _ in range(24):
            box = page.evaluate("""(sels) => {
                for (const s of sels) for (const el of document.querySelectorAll(s)) {
                    const r = el.getBoundingClientRect();
                    if (el.offsetParent !== null && r.width > 40 && r.height > 10) { el.setAttribute('data-pm-live-box', ''); return s; }
                }
                return null; }""", selectors)
            if box:
                break
            page.wait_for_timeout(500)
        if not box:
            if WALLS.search(page.inner_text("body")[:2000]):
                return "skipped", notes + ["no chat box: the logged-out page asks to sign in"]
            return "fail", notes + ["no chat box matched sites.js's selectors"]
        notes.append(f"chat box: {box}")
        problem = click_through_notices(page, "[data-pm-live-box]", notes)
        if problem:
            shot("1-box-covered")
            return "fail", notes + [f"could not click into the chat box: {problem}"]
        page.keyboard.type(DRAFT, delay=8)
        try:
            page.wait_for_selector("#pm-trigger.pm-pill-invite", timeout=5000)
            notes.append("⊕ Improve appeared")
        except Exception:
            shot("1-no-invite")
            return "fail", notes + ["typing a draft did not turn the pill into ⊕ Improve: the box is not being watched"] + errors[:2]
        shot("1-invite")

        problem = click_through_notices(page, "#pm-trigger", notes)
        if problem:
            shot("2-pill-covered")
            over = page.evaluate("""() => { const r = document.getElementById('pm-trigger').getBoundingClientRect();
                const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${(el.innerText || '').trim().slice(0, 40)}" in ${(el.closest('[role=dialog],[aria-modal],[class*=banner],[class*=cookie]')?.getAttribute('aria-label') || el.parentElement?.className || '').toString().slice(0, 60)}` : 'nothing'; }""")
            return "fail", notes + [f"the pill could not be clicked: covered by {over}"]
        try:
            page.wait_for_selector("#pm-card #pm-card-accept", timeout=15000)
        except Exception:
            shot("2-no-card")
            toasts = page.locator(".pm-toast").all_inner_texts()
            return "fail", notes + [f"no finished rewrite card; toasts {toasts}"] + errors[:2]
        text = page.inner_text("#pm-card .pm-card-text").strip()
        if text != REPLY:
            return "fail", notes + [f"the card shows {text[:60]!r}, not the rewrite"]
        notes.append("rewrite streamed into the card")
        shot("2-card")

        problem = click_through_notices(page, "#pm-card-accept", notes)
        if problem:
            return "fail", notes + [f"Replace could not be clicked: {problem}"]
        try:
            page.wait_for_function("t => (document.querySelector('[data-pm-live-box]')?.innerText || document.querySelector('[data-pm-live-box]')?.value || '').includes(t)",
                                   arg=REPLY[:40], timeout=6000)
            notes.append("Replace wrote it into the chat box")
        except Exception:
            shot("3-no-replace")
            return "fail", notes + ["Replace did not write into the site's chat box"] + errors[:2]
        shot("3-replaced")
        if errors:
            return "fail", notes + ["page errors: " + "; ".join(errors[:2])]
        return "pass", notes
    finally:
        page.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true", help="show the browser (some sites wall off headless)")
    ap.add_argument("--only", help="comma-separated site names: " + ", ".join(n for n, _ in SITES))
    ap.add_argument("--profile", help="a Chromium profile directory, for a signed-in claude.ai")
    ap.add_argument("--shots", help="directory for a screenshot of each step")
    args = ap.parse_args()
    only = set(args.only.split(",")) if args.only else None
    selectors = composer_selectors()

    tmp = None
    profile = args.profile
    if not profile:
        tmp = tempfile.mkdtemp(prefix="pm-live-")
        profile = tmp
    results = []
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                profile, channel="chromium", headless=not args.headed, viewport={"width": 1440, "height": 900},
                args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
            )
            ctx.route("https://api.groq.com/**", lambda r: r.fulfill(status=200, content_type="text/event-stream", body=FAKE_STREAM))
            sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
            # A key (its calls are faked above), consent, onboarding done and tips off,
            # so the first ⊕ rewrites instead of asking to set up.
            sw.evaluate("""chrome.storage.local.set({ byok_provider: 'groq', byok_key: 'gsk_live_check',
                byok_model: 'qwen/qwen3.8-27b', pm_data_consent_v1: true, pm_onboarded: true, pm_tips_off: true })""")
            for name, url in SITES:
                if only and name not in only:
                    continue
                if name == "claude" and not args.profile:
                    results.append((name, "skipped", ["needs a login: pass --profile with a signed-in profile"]))
                    continue
                status, notes = check_site(ctx, name, url, selectors, args.shots)
                results.append((name, status, notes))
            ctx.close()
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)

    width = max(len(n) for n, _, _ in results) if results else 8
    for name, status, notes in results:
        print(f"{name:<{width}}  {status.upper():7}  " + " · ".join(notes))
    failed = [n for n, s, _ in results if s == "fail"]
    passed = [n for n, s, _ in results if s == "pass"]
    print(f"\n{len(passed)} passed, {len(failed)} failed, {len(results) - len(passed) - len(failed)} skipped")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
