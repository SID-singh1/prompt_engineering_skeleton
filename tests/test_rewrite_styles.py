"""The three rewrite styles must mean the same thing on every route.

A style's instructions are written in three places: the router that serves
/enhance (the copy the evals read), the older prompt builder, and the
extension's direct path, which calls the user's own provider without the
server. They cannot import one another (two are Python, one is a browser
module), so this file is what keeps them one definition.
"""
import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROUTER = ROOT / "backend" / "routers" / "prompts.py"
BUILDER = ROOT / "backend" / "services" / "prompt_builder.py"
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


def test_the_router_defines_exactly_three_styles():
    assert set(_literal(ROUTER, "MODE_INSTRUCTIONS")) == STYLES


def test_the_prompt_builder_copy_matches_the_router():
    assert _literal(BUILDER, "MODE_INSTRUCTIONS") == _literal(ROUTER, "MODE_INSTRUCTIONS")


def test_the_direct_path_sends_the_router_text_word_for_word():
    router = {k: v.strip() for k, v in _literal(ROUTER, "MODE_INSTRUCTIONS").items()}
    js = _js_mode_rules()
    assert set(js) == STYLES, "providers.js MODE_RULES could not be parsed, or a style is missing"
    for style in STYLES:
        assert js[style] == router[style], f"{style} differs between providers.js and the router"


def test_deep_no_longer_splits_vague_asks_on_the_direct_path():
    # The drift this file exists for: the old paraphrase said the opposite.
    assert all("numbered sub-questions" not in rule for rule in _js_mode_rules().values())


def test_every_route_uses_the_same_temperatures():
    router = _temperatures(ROUTER)
    assert set(router) == STYLES
    assert _temperatures(BUILDER) == router
    assert _js_temperatures() == router
