# Installing a test build of Prompt Memory

For testers, before the extension is on the Chrome Web Store. The build is
the ZIP from `python3 scripts/package_extension.py`
(`dist/prompt-memory-<version>.zip`). Chrome on Windows and on Mac; Edge and
Brave take the same steps (`edge://extensions`, `brave://extensions`).

## Windows

1. **Unzip it.** Right-click the ZIP → **Extract All…** → **Extract**. Chrome
   cannot load a ZIP, only the folder. The folder you want is the one with
   `manifest.json` directly inside it.
2. Open **`chrome://extensions`** in the address bar.
3. Turn on **Developer mode** (the switch at the top right).
4. Click **Load unpacked** and choose the extracted folder.
5. A welcome tab opens: **Agree and continue**, then pick **Sign in with
   Google** or **Use your own free key**.
6. **Pin it.** Click the puzzle-piece icon at the top right of Chrome, then
   the pin beside Prompt Memory, so the settings are one click away.
7. Open ChatGPT, Claude, Gemini, Perplexity or Grok, type a draft and press
   the round **⊕** at the bottom corner of the page.

### If the shortcut does nothing

Chrome only gives an extension its shortcut if no other extension already has
it, and Ctrl+Shift+E is a popular one on Windows. Open the Prompt Memory popup:
if the shortcut reads **Not set**, click **Set it in Chrome** (or go to
`chrome://extensions/shortcuts`) and choose one. Clicking ⊕ always works.

### Things Windows shows that are not problems

- **"Disable developer mode extensions"** when Chrome starts: click the ×
  (or **Keep**). It comes with every unpacked extension and goes away once the
  extension comes from the Web Store.
- **"Manifest file is missing or unreadable"**: you chose the ZIP or a parent
  folder. Choose the folder that has `manifest.json` in it.

## Mac

Double-click the ZIP to unzip it, then follow steps 2–7 above. The shortcut is
⌘⇧E.

## Updating to a newer build

1. Unzip the new build over the old folder (replace everything), or into a new
   folder, then **Remove** the old one in `chrome://extensions` and
   **Load unpacked** the new folder.
2. Click the **↻ reload** icon on the Prompt Memory card in `chrome://extensions`.
3. **Refresh every open chat tab.** A tab that was open during the update
   still runs the old copy until it reloads, and the plus button and the
   shortcut do nothing there.

Removing the extension and loading it again counts as a fresh install: the
welcome tab and the first-run tips come back, and a key saved in the old copy
has to be added again.
