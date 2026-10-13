"""Build the exact Chrome Web Store upload ZIP, excluding test harnesses."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"
MANIFEST = json.loads((EXT / "manifest.json").read_text())
FILES = (
    "manifest.json", "background.js", "sites.js", "content.js", "styles.css",
    "popup.html", "popup.js", "lib/providers.js",
    "icon16.png", "icon48.png", "icon128.png",
)

def manifest_files(m):
    """Every file the manifest itself names: a ZIP missing one fails to load in Chrome."""
    named = {m["background"]["service_worker"], m["action"]["default_popup"]}
    named |= set(m.get("icons", {}).values()) | set(m["action"].get("default_icon", {}).values())
    if m.get("options_ui", {}).get("page"):
        named.add(m["options_ui"]["page"])
    for script in m.get("content_scripts", []):
        named |= set(script.get("js", [])) | set(script.get("css", []))
    for resource in m.get("web_accessible_resources", []):
        named |= {r for r in resource.get("resources", []) if "*" not in r}
    return named


missing = sorted(manifest_files(MANIFEST) - set(FILES))
if missing:
    # sites.js once went unlisted here: the ZIP would have installed and then
    # failed to run its content script on every site.
    raise SystemExit(f"The manifest names files the release ZIP leaves out: {', '.join(missing)}")
if MANIFEST["manifest_version"] != 3:
    raise SystemExit("Chrome Web Store release must use Manifest V3")
for name in FILES:
    if not (EXT / name).is_file():
        raise SystemExit(f"Missing release file: {name}")
if any("localhost" in host or "127.0.0.1" in host for host in MANIFEST["host_permissions"]):
    raise SystemExit("Development host permission in release manifest")
if "activeTab" in MANIFEST["permissions"]:
    raise SystemExit("Unused activeTab permission in release manifest")

OUTPUT = ROOT / "dist" / f"prompt-memory-{MANIFEST['version']}.zip"
OUTPUT.parent.mkdir(exist_ok=True)
with ZipFile(OUTPUT, "w", ZIP_DEFLATED) as archive:
    for name in FILES:
        archive.write(EXT / name, name)
with ZipFile(OUTPUT) as archive:
    if set(archive.namelist()) != set(FILES):
        raise SystemExit("Release ZIP file list differs from approved allowlist")
    json.loads(archive.read("manifest.json"))
print(OUTPUT)
