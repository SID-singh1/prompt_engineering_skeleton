"""Render the store images from assets.html into docs/store/.

    python docs/store/src/render_assets.py    (needs Playwright and Chrome)
"""
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = HERE.parent
SHOTS = {
    "icon128": "store-icon-128.png",
    "logo512": "logo-512.png",
    "small": "promo-small-440x280.png",
    "marquee": "promo-marquee-1400x560.png",
}

with sync_playwright() as p:
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 1500, "height": 1600}, device_scale_factor=1)
    page.goto((HERE / "assets.html").as_uri())
    page.wait_for_timeout(300)
    for element, name in SHOTS.items():
        # Transparent background for the icon and the round logo; the tiles paint their own.
        page.locator(f"#{element}").screenshot(path=str(OUT / name), omit_background=True)
        print(OUT / name)
    browser.close()
