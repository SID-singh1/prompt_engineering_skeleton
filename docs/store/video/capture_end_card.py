"""frame-6-end-card.png: the ⊕ mark and the line, 1920x1080, for the last clip."""
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent
HTML = """<!doctype html><meta charset=utf-8><style>
html,body{margin:0;width:1920px;height:1080px;background:#0b0d10;color:#eef2f1;font-family:"Segoe UI",system-ui,sans-serif}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px;
 background:radial-gradient(45% 55% at 50% 42%,rgba(80,200,168,.16),transparent 70%),radial-gradient(40% 50% at 85% 10%,rgba(113,89,235,.14),transparent 70%),#0b0d10}
h1{margin:0;font-size:92px;font-weight:750;letter-spacing:-.02em}
p{margin:0;font-size:38px;color:#9aa6a2}
.a{background:linear-gradient(90deg,#38cdaf,#4b97ca 55%,#7159eb);-webkit-background-clip:text;background-clip:text;color:transparent}
small{font-size:28px;color:#6f7b77}
</style>
<svg width="220" height="220" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#38CDAF"/><stop offset=".5" stop-color="#4B97CA"/><stop offset="1" stop-color="#7159EB"/></linearGradient></defs>
<rect width="96" height="96" rx="22" fill="url(#g)"/><circle cx="48" cy="48" r="29.5" fill="none" stroke="#fff" stroke-width="8"/><path d="M48 34v28M34 48h28" stroke="#fff" stroke-width="8" stroke-linecap="round"/></svg>
<h1>Prompt Memory</h1>
<p>Better prompts, <span class="a">one click.</span></p>
<small>Free on the Chrome Web Store</small>"""

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    pg = b.new_page(viewport={"width": 1920, "height": 1080})
    pg.set_content(HTML)
    pg.wait_for_timeout(300)
    pg.screenshot(path=str(OUT / "frame-6-end-card.png"))
    b.close()
print("ok")
