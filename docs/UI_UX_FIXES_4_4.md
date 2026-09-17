# Prompt Memory 4.4: fixes and verification

16 September 2026. Local working tree; not published or deployed. The earlier Chrome reproduction used v4.3. The new v4.4 build has not yet been loaded and verified in Chrome.

## Project boundaries reviewed

- `extension/popup.html` / `popup.js`: disclosure, Google sign-in, connected profile, optional API-key configuration, account deletion.
- `extension/background.js`: Chrome command forwarding, OAuth coordination, direct-provider calls and per-request routing; session draft access.
- `extension/content.js` / `styles.css`: page composer integration, review card, library, voice, draft persistence, insertion, feedback and acceptance.
- FastAPI `backend/main.py` and architecture documentation: authenticated enhancement and saved-prompt services, MongoDB records, Qdrant semantic retrieval, provider fallback, and private aggregate dashboard. This review did not certify every backend route or production configuration.
- `website/`: public onboarding/privacy pages and private builder dashboard. Previous website improvements remain local. The backend root is a health endpoint, not evidence of a hosted landing page.

## Problems fixed

| Problem | Change in 4.4 |
|---|---|
| Shift+Tab inserted a rewrite instead of moving focus; reproduced in Chrome v4.3 | Both Tab directions now always retain native navigation. Removed insertion keyboard hints that advertised Tab. |
| Open card intercepted unrelated page shortcuts and ordinary backslash typing | Card handler checks focus. Save/redo only operate from card controls; typing in the host composer remains typing. |
| UI said “accept” without explaining draft replacement | Primary review action says Insert, Replace draft, or Use original according to the displayed content and composer. |
| Pill showed enhanced text but could apply original after switching comparison view | Pill insertion explicitly selects enhanced text. |
| Persisted dimensions could exceed a small viewport or contain invalid values | Finite-value validation, viewport caps and scrollable card; library minimizes the card when insufficient horizontal room remains. Preferred dimensions stay separate from temporary viewport clamping. |
| Header/grip capture was lost when redraw replaced those elements | Capture belongs to stable card; cleanup runs on pointer-up, cancel, lost capture, redraw and removal. A small movement threshold prevents clicks from detaching the card. |
| Movement required dragging | Added Layout controls for movement in four directions, width/height adjustment and reset. Resize grip is a native button with keyboard access. |
| Small window controls and focus lost on redraw/minimize | Enlarged header/grip targets; restore focus by control ID across redraw, return focus to pill on minimize and to Layout after header reset. |
| Pill collision logic ignored floating cards | Floating and attached cards both participate in the existing avoidance calculation. Complex host layouts still require browser validation. |
| Popup showed Ctrl shortcuts on Mac and outdated sidebar instructions | Popup queries actual Chrome command bindings and explains Enhance, Library and review-before-insert. Removed misleading fixed shortcut labels from content UI. |
| Privacy preferences could remain stale across tabs; listener registration could throw on invalidated context | Guarded registration and synchronize consent, tracking and context changes. |
| Installed and local builds were difficult to distinguish | Bumped manifest, popup and release docs to 4.4. |

## Verification actually completed

- `python3 scripts/test_extension_ui_runtime.py`: **189 runtime assertions pass**. Executes extracted production JS functions in macOS JavaScriptCore with controlled event/DOM collaborators. Covers Tab across states/focus, shortcut scope, voice Escape, invalid/small viewport geometry, gesture threshold, capture cleanup, click movement/resize/reset, and pill content selection. These are unit-level runtime checks, not browser layout tests.
- JavaScript syntax checks: content script, popup, website main and builder JS pass.
- Existing extension source assertions: **111 passed, 2 skipped**, run through a small standalone adapter because pytest is unavailable. Parameterized modal cases were included. These remain static source checks; no claim of full pytest execution.
- `python3 tests/test_account_deletion_contract.py`: **5 passed**. Existing backend regression checks; no new backend mutations in this change.
- Packaging: `python3 scripts/package_extension.py` produced `dist/prompt-memory-4.4.zip`, with the runtime-file allowlist checked by the script.
- No production deployment, store submission, account deletion, real email sending, or new API-key entry.

## Browser verification blocked at reload

Opening `chrome://extensions/?id=pjechenccmibmckddlejfiklkkkfodmp` was rejected by automatic browser safety review: the browser URL policy blocks the page and prohibits alternate-route workarounds. The user was asked to reload the installed extension manually and confirm version 4.4. No confirmation has arrived as of this report. The old live Shift+Tab reproduction is evidence of the defect, not evidence that 4.4 fixes it in Chrome.

After reload, use a fresh supported chat with a fictional prompt:

1. Verify popup v4.4 and actual Mac shortcut labels.
2. Enhance once. Before inserting, Tab and Shift+Tab through controls; composer text must remain unchanged.
3. Compare original, then use the pill's Apply/Insert: enhanced text must be inserted.
4. Open Layout. Move/resize with clicks, drag header and grip, reset; check keyboard focus.
5. Drag during streaming completion; verify no stuck state, then minimize/reopen.
6. Test narrow/short windows, zoom and Library open; essential controls must remain reachable.
7. Confirm explicit insertion does not send. Remove unsent synthetic text afterward.

## Remaining work, not claimed fixed

Cross-platform visual checks, actual resize/drag behavior, screen-reader testing, OAuth cancellation/expiration, provider/network failures, and live website testing remain pending. No public website URL was supplied. The earlier roadmap's private dashboard request race, chart accessibility, broader onboarding and library discoverability work remain open. This release addresses the confirmed review-card defects and closely related issues; it is not an assertion that the entire project is defect-free or Chrome Web Store approved.
