"""The three rewrite styles must mean the same thing on every route.

A style's instructions are written in two places: the prompt builder that
every /enhance route imports (the copy the evals read), and the extension's
direct path, which calls the user's own provider without the server. They
cannot import one another (one is Python, one is a browser module), so this
file is what keeps them one definition.
"""
import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "backend" / "services" / "prompt_builder.py"  # the one copy
PROVIDERS_JS = ROOT / "extension" / "lib" / "providers.js"
STYLES = {"quick", "deep", "creative"}


def _literal(path: Path, name: str):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{name} not found in {path.name}")


def _temperatures(path: Path) -> dict:
    """The dict literal inside _temperature_for()."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_temperature_for")
    call = next(n for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute))
    return ast.literal_eval(call.func.value)


def _js_mode_rules() -> dict:
    js = PROVIDERS_JS.read_text(encoding="utf-8")
    block = js[js.index("const MODE_RULES = {"):js.index("const TEMPERATURE = ")]
    return {k: v.strip() for k, v in re.findall(r"^  (\w+): `\n(.*?)\n`\.trim\(\),$", block, re.S | re.M)}


def _js_temperatures() -> dict:
    js = PROVIDERS_JS.read_text(encoding="utf-8")
    body = re.search(r"const TEMPERATURE = \{([^}]*)\}", js).group(1)
    return {k: float(v) for k, v in re.findall(r"(\w+):\s*([\d.]+)", body)}


def test_the_builder_defines_exactly_three_styles():
    assert set(_literal(BUILDER, "MODE_INSTRUCTIONS")) == STYLES


def test_the_router_imports_the_styles_instead_of_copying_them():
    from backend.routers import prompts
    from backend.services import prompt_builder
    assert prompts.MODE_INSTRUCTIONS is prompt_builder.MODE_INSTRUCTIONS


def test_the_direct_path_sends_the_router_text_word_for_word():
    router = {k: v.strip() for k, v in _literal(BUILDER, "MODE_INSTRUCTIONS").items()}
    js = _js_mode_rules()
    assert set(js) == STYLES, "providers.js MODE_RULES could not be parsed, or a style is missing"
    for style in STYLES:
        assert js[style] == router[style], f"{style} differs between providers.js and the router"


def test_deep_no_longer_splits_vague_asks_on_the_direct_path():
    # The drift this file exists for: the old paraphrase said the opposite.
    assert all("numbered sub-questions" not in rule for rule in _js_mode_rules().values())


def test_every_route_uses_the_same_temperatures():
    server = _temperatures(BUILDER)
    assert set(server) == STYLES
    assert _js_temperatures() == server


CONTENT_JS = ROOT / "extension" / "content.js"


def test_the_default_style_survives_a_reload():
    js = CONTENT_JS.read_text(encoding="utf-8")
    load = js[js.index('storageGet(["pm_tracking"'):]
    assert '"pm_mode"' in load[:120], "the saved default is never read back"
    assert "setDefaultStyle(result.pm_mode, false)" in load[:600]
    assert "storageSet({ pm_mode: currentMode })" in js
    assert "changes.pm_mode" in js, "another tab's choice is ignored until reload"


def test_the_panel_does_not_hardcode_deep_as_selected():
    js = CONTENT_JS.read_text(encoding="utf-8")
    assert 'class="pm-mode-pill pm-mode-pill-active"' not in js
    assert "syncStylePills()" in js


def _js_object(js: str, name: str) -> str:
    start = js.index(f"const {name} = ")
    return js[start:js.index("};", start) + 2]


def test_the_card_knows_the_same_three_styles():
    js = CONTENT_JS.read_text(encoding="utf-8")
    assert re.search(r'const STYLES = \["quick", "deep", "creative"\];', js)
    names = _js_object(js, "STYLE_NAMES")
    hints = _js_object(js, "STYLE_HINTS")
    for style in STYLES:
        assert f"{style}:" in names and f"{style}:" in hints


def test_every_style_names_the_other_two_by_what_they_change():
    verbs = _js_object(CONTENT_JS.read_text(encoding="utf-8"), "STYLE_VERBS")
    for on in STYLES:
        row = re.search(rf"^  {on}: \{{([^}}]*)\}},?$", verbs, re.M)
        assert row, f"no verbs for a {on} rewrite"
        assert set(re.findall(r"(\w+): \"", row.group(1))) == STYLES - {on}


def test_a_rerun_that_fails_or_is_cancelled_keeps_the_draft():
    js = CONTENT_JS.read_text(encoding="utf-8")
    fail = js[js.index("function failStreamingModal("):]
    assert fail.index("restoreFromRerun()") < fail.index('cardState = "error"'), \
        "a failed rerun must restore the draft before becoming an error card"
    cancel = js[js.index("function cancelStreaming("):js.index("function restoreFromRerun(")]
    assert "restoreFromRerun()" in cancel


def test_drafts_saved_before_versions_existed_still_load():
    js = CONTENT_JS.read_text(encoding="utf-8")
    restore = js[js.index("async function restoreDraft("):js.index("// KEYBOARD SHORTCUT")]
    assert ": [draft.result]" in restore


def test_the_daily_count_is_recorded_before_the_card_is_drawn():
    # The style buttons say "· N left"; drawn before the count arrived, they
    # lagged one rewrite behind and were blank on the first of the day.
    js = CONTENT_JS.read_text(encoding="utf-8")
    run = js[js.index("async function runBackendEnhance("):js.index("function askWorker(")]
    assert run.index("usageData.count = metadata.usage_today.used") < run.index("finalizeStreamingModal(lastEnhanceResult)")
