"""
The extension's half of the anonymous tier: with no account and no key, the
first Improve rewrites (Quick, the draft alone) instead of asking the user to
set something up, and running out offers a sign-in on the bar itself.
"""

import re
from pathlib import Path

EXT = Path(__file__).resolve().parent.parent / "extension"
CONTENT = (EXT / "content.js").read_text(encoding="utf-8")
WORKER = (EXT / "background.js").read_text(encoding="utf-8")


def _body(src: str, name: str) -> str:
    m = re.search(rf"(?:async )?function {name}\([^)]*\) \{{", src)
    assert m, name
    depth, i = 0, m.end() - 1
    for j in range(i, len(src)):
        depth += {"{": 1, "}": -1}.get(src[j], 0)
        if depth == 0:
            return src[i:j + 1]
    raise AssertionError(f"unbalanced {name}")


def test_no_account_and_no_key_is_the_free_tier_not_a_setup_wall():
    route = _body(WORKER, "resolveRoute")
    assert 'return "anon";' in route
    assert 'return "none"' not in route and 'return "expired"' not in route


def test_the_worker_hands_out_a_token_and_prefetches_it_on_install():
    assert "/auth/anonymous" in _body(WORKER, "getAnonToken")
    assert re.search(r'anonToken: route === "anon" \? await getAnonToken\(\)', WORKER)
    install = WORKER[WORKER.index('if (reason !== "install") return;'):]
    assert "getAnonToken();" in install


def test_signing_in_retires_the_anonymous_token():
    finish = WORKER[WORKER.index("const finish = async (data) =>"):]
    assert 'chrome.storage.local.remove("anon_token")' in finish[:800]


def test_a_free_rewrite_sends_the_draft_alone():
    stream = _body(CONTENT, "enhancePromptStream")
    assert 'lastRoute?.route === "anon"' in stream
    assert "anonToken ? [] : scrapeConversation()" in stream, "no chat context on the free tier"
    assert "anonToken ? null : await askWorker" in stream, "no key forwarded on the free tier"
    assert "!anonToken && selectedPromptIds" in stream


def test_consent_describes_the_route_it_is_for():
    copy = _body(CONTENT, "consentCopy")
    assert 'route === "anon"' in copy and "nothing is saved" in copy
    resolve = _body(CONTENT, "resolveEnhanceRoute")
    assert resolve.index('PM_GET_ROUTE') < resolve.index("ensureDataConsent(route.route)"), \
        "the route is known before consent, so consent can name it"


def test_running_out_offers_sign_in_on_the_bar():
    limit = _body(CONTENT, "simpleLimit")
    assert 'simple.phase = "limit"' in limit and "applyToInput(back)" in limit, \
        "the draft goes back as it was"
    bar = _body(CONTENT, "renderSimpleBar")
    assert 'data-act="signin"' in bar
    assert 'case "signin": simpleSignIn(); return;' in CONTENT
    assert "PM_START_GOOGLE_AUTH" in _body(CONTENT, "simpleSignIn")


def test_the_free_tier_bar_offers_only_what_it_can_deliver():
    bar = _body(CONTENT, "renderSimpleBar")
    assert "const steps = anon ? \"\"" in bar, "no More detail: the free tier is Quick only"
    menu = _body(CONTENT, "simpleMenuHtml")
    assert "if (isAnonymous())" in menu and "Sign in with Google for more" in menu


def test_the_empty_library_offers_to_save_the_users_details():
    """What people retype in every long chat is their own background; the
    empty library says so and starts that prompt in one click."""
    rows = _body(CONTENT, "libRowsHtml")
    assert 'data-act="aboutme"' in rows and "<kbd>//</kbd>" in rows
    assert 'case "aboutme": libMenu = false; openAboutMe(); return;' in CONTENT
    about = _body(CONTENT, "openAboutMe")
    assert 'title: "About me"' in about and "//about" in about


def test_simple_mode_still_teaches_slash():
    """Simple mode is the default now; the // tip must not be classic-only."""
    body = _body(CONTENT, "tipsOnComposerChanged")
    assert "if (simpleMode) { maybeTipSimple(); if (!activeTip) maybeTipSlash(); return; }" in body
