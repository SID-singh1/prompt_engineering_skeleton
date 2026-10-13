"""Build the Chrome Web Store ZIP, unpack it, and run the end-to-end checks on it.

The store gets the ZIP, not the extension folder: a file left out of it (as
sites.js nearly was) passes every other check and fails for every user. This
runs check_extension_e2e.py against the ZIP's own contents.

    python3 scripts/check_release_zip.py
"""
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
built = subprocess.run([sys.executable, str(ROOT / "scripts/package_extension.py")],
                       capture_output=True, text=True)
if built.returncode:
    sys.exit(built.stdout + built.stderr)
zip_path = Path(built.stdout.strip().splitlines()[-1])
with tempfile.TemporaryDirectory(prefix="pm-release-") as unpacked:
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(unpacked)
    print(f"{zip_path.name}: {len(os.listdir(unpacked))} entries, unpacked to a fresh folder")
    run = subprocess.run([sys.executable, str(ROOT / "scripts/check_extension_e2e.py")],
                         env={**os.environ, "PM_EXT_DIR": unpacked}, capture_output=True, text=True)
    out = (run.stdout + run.stderr).strip().splitlines()
    print(out[-1] if out else "(no output)")
    sys.exit(run.returncode)
