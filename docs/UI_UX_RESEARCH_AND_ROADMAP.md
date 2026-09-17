# Prompt Memory: UI/UX audit and implementation roadmap

Reviewed 15 September 2026. Scope: local website, popup, injected rewrite card, setup/privacy flows, and private builder dashboard. This is a source-based expert review informed by published research—not a usability study with participants or a completed live-browser audit.

## Recommendation

Make the first successful rewrite the organizing task: understand → install → choose setup → write → enhance → review → insert. Keep saved context, modes, API configuration, voice, and account management available without making newcomers learn them first. Preserve the dark/mint identity; reduce competing actions and make recovery predictable before adding decorative UI.

The most consequential remaining issue is keyboard behavior: the open, ready card currently captures Tab globally, including Shift+Tab, and calls acceptCard(). That prevents normal navigation and can replace the composer while the user intended to move focus. Treat this as a release blocker. Dragging/resizing alone does not solve the card obstruction problem.

## Research and how it applies

- [NN/g: usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/) supports visible status, recognizable controls, consistency, and easy recovery. Application: one vocabulary for setup, enhancement, insertion, saving, and failure across all surfaces.
- [NN/g: progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/) supports presenting frequent tasks first and exposing advanced choices on demand. Application: Google-first setup, with a clearly labeled API-key alternative; put provider/model configuration inside that alternative. This is a design rationale, not evidence that this specific ordering improves our conversion.
- [Microsoft Research: Guidelines for Human-AI Interaction](https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/) emphasizes communicating capabilities and limits and supporting correction. Application: label examples as illustrative, show the source prompt, allow editing/dismissal, avoid silently adding requirements, and keep sending under the user's control.
- [W3C: dragging movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) requires a single-pointer alternative to dragging. Keyboard arrows alone are insufficient for this criterion. Application: a Layout menu with clickable position/size controls as well as drag handles.
- [W3C: target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) specifies a 24×24 CSS-pixel minimum with exceptions. Aim for 32–40px card controls and 44px primary controls; inspect spacing exceptions rather than claiming every small icon automatically fails.
- [W3C: reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) informs narrow-width and zoom checks. Test 320 CSS pixels and 400% zoom; don't hide overflow to conceal inaccessible content.
- [Grammarly's official extension guide](https://support.grammarly.com/hc/en-us/articles/115000091592-Grammarly-s-browser-extension-user-guide) provides a useful adjacent-product pattern: suggestions near text, explicit acceptance/dismissal, and a fuller review surface. This is a documented pattern comparison, not hands-on competitor testing.
- [web.dev: Web Vitals](https://web.dev/articles/vitals) supplies performance acceptance targets: LCP ≤2.5s, INP ≤200ms, CLS ≤0.1 at the 75th percentile. We have not measured these for Prompt Memory.

## Changes implemented locally in this review

| Problem found | Change | Verification |
|---|---|---|
| Installation CTAs dropped visitors into GitHub without guidance | CTAs now lead to a dedicated installation section, including extraction, Load unpacked, pinning, setup, and refreshing chat tabs | HTML targets resolve; external repository availability not verified |
| Website featured BYOK while popup starts with Google | Shared-key sign-in is the featured path; API key explicitly optional | Source review |
| Manual distribution looked like a normal store install | Hero and installation section disclose manual installation and no current store listing | Source review; must update when a listing exists |
| White text on gradient CTA had weak contrast | Solid mint actions with dark text | 9.52:1 calculated contrast; old mint endpoint 2.07:1 |
| Muted text on cards was difficult to read | Lighter muted token | 6.91:1 calculated contrast; previous 3.53:1 |
| Main nav disappeared at mobile breakpoint | Navigation remains visible on a second row | CSS review; narrow-screen rendering pending |
| No skip link or main landmark | Added both, visible keyboard focus and anchor offsets | Unique IDs, one main, one h1 and fragment checks pass |
| Scroll animation hid content and imposed long cumulative delays | Cards remain visible immediately; removed observer-dependent hiding | Source review; browser checks pending |
| Motion had no user-preference fallback | Reduced-motion CSS disables animations, transitions and smooth scrolling | Source review |
| Example silently invented an audience | Input now includes audience and length constraints; example labeled illustrative | Editorial review |
| “Passive learning” copy conflicted with opt-in tracking | Copy describes explicit saving/feedback and tracking off by default | Compared with content-script defaults |
| Setup had no first-use exercise | Added fictional email prompt and missing-button troubleshooting | No sample sent to any service |

These changes are in website/index.html, website/styles.css, and website/main.js. They are not deployed. No extension code was changed in this review.

## Prioritized remaining work

Priority indicates proposed implementation order, not a measured frequency of failure.

| Priority | Evidence and risk | Update | Acceptance criteria |
|---|---|---|---|
| P0 | content.js ready-card keydown handler intercepts Tab without checking focus or Shift | Restore native Tab/Shift+Tab navigation. Scope shortcuts to composer/card, leave unrelated inputs alone; use explicit Insert as the primary action | Tab through every card control in both directions without modifying a draft; unrelated host inputs and shortcuts work |
| P0 | Real public URL and live signup/install flow not tested | Verify deployed site, repository download and OAuth configuration against the shipped extension | A fresh tester installs and completes one rewrite using the published instructions; no developer help or console errors |
| P1 | Card minimum width/height can exceed available room; docked minimums have similar risks | Cap against actual viewport bounds, allow content scrolling; preserve preferred geometry separately from temporary clamping | No unreachable actions at small viewport sizes/zoom, with library open, after resize and navigation |
| P1 | Card pointer capture is on header/grip replaced by openCard innerHTML | Put gesture lifecycle on a stable element; clean up on lost capture, cancel, removal and stream rerender; use a movement threshold | Stream completion during drag doesn't freeze movement or leave stale CSS; simple header click doesn't detach |
| P1 | Move requires dragging; only resize has keyboard arrows | Add Layout controls for move left/right/up/down, width/height changes, docking and reset; keep equivalent keyboard access | All movement/resize operations possible with clicks alone and keyboard alone; focus remains visible |
| P1 | Free card isn't included in pill collision check; controls can overlap | Coordinate pill/card/library placement; keep composer send/attachment controls accessible by default | Test both docks and all card states on each supported site; user can recover from intentional overlap |
| P1 | Library is exposed on hover/focus and via Shift-click | Evaluate a persistent labeled Library action in the expanded pill or popup; keep compact idle state | New participants find saved work without being taught a hidden gesture |
| P1 | Consent and setup contain several different data routes | Explain “What is sent” beside context/BYOK/voice choices; retain affirmative consent before transmission | Test decline, consent persistence, revocation, signed-out BYOK and signed-in BYOK separately; no network action before required consent |
| P1 | Multiple enhancement/auth states exist across popup and content UI | Standardize loading, cancellation, expired sign-in, quota, provider-key failure and offline recovery | Original draft retained on every failure; retry doesn't duplicate a request or falsely report success |
| P2 | Settings and copy use separate styling across popup, page and overlays | Define shared design tokens and a small control/state specification | Light/dark theme, hover, focus, disabled, loading and error states reviewed side by side |
| P2 | Builder loadDashboard allows overlapping day-range requests | Cancel superseded requests and ignore stale responses; invalidate on lock | Delayed 7-day response cannot overwrite selected 30-day range; locked session cannot render a late response |
| P2 | Builder chart values depend on hover titles and missing values may show zero | Provide textual/table equivalents; distinguish unavailable from zero | Values readable by keyboard/screen reader; offline data never looks like a real zero |
| P2 | Privacy page has standalone styling | Align typography, focus, link contrast and mobile layout with landing page | Readable at zoom; all privacy/account-deletion links work |

## Proposed experience and component contract

**Landing page:** one clear primary CTA; show who it helps, one honest before/after, three usage steps, setup choices, installation and support. Keep the pre-release status until the real Web Store listing replaces the manual path. Avoid unverified user counts, testimonials, accuracy claims, or guaranteed improved outputs.

**First run:** concise disclosure → Google sign-in primary / own key secondary → ready state naming supported sites → optional safe sample. Explain provider billing beside BYOK, not after an error. Existing users should see their current state and next action rather than repeated onboarding.

**Rewrite card:** default compact review near the composer with a capped text area, clear Insert, Compare, and Minimize. Use “Replace draft” when the composer contains text, reserving “Insert” for an empty composer. Make discard distinct from minimize. Suggested layout options: near composer, float left/right, compact/comfortable, reset, plus fine movement controls. Preserve the user's position without allowing controls offscreen. This is a proposed interaction contract; some existing labels and behaviors already differ and need coordinated updating.

**AI feedback:** streaming status plus Cancel; retain original throughout; error explains the next action. Show a quiet insertion confirmation with Undo only once exact composer-state restoration is implemented and tested. Do not add a decorative Undo that can erase later typing. Ask for optional rating after success, without blocking the next task.

**Library:** distinguish no saved prompts, no search results, loading and failure. Provide a first-save action, clear context-selection count, and an explanation of when selected prompts are sent. Test duplicate saves and deletion explicitly.

**Visual system:** keep mint as the action/focus color, purple as decoration, dark neutral surfaces, restrained borders. Use 8/12/16/24px spacing steps and readable body text. Avoid color-only status. Prefer labeled controls over tooltips as the only instruction. Check all tokens in both themes before declaring accessibility conformance.

## Test plan and release gates

Run in a clean Chrome profile with only Prompt Memory installed; use fictional content and test credentials. Record build/version, URL, viewport, steps, expected/actual, screenshot, console/network result. Do not include tokens or private prompts in the report.

| Journey | Cases | Pass condition |
|---|---|---|
| Website | 320/390/768/1440px, 200%/400% zoom, keyboard, reduced motion, JS disabled | Content/CTAs accessible; no hidden navigation, unreadable text, focus obstruction or horizontal content loss |
| Setup | Fresh profile, decline consent, Google success/cancel/failure, valid/invalid/missing BYOK | Clear recovery; no accidental data transmission; status persists appropriately |
| First rewrite | Empty input; fictional email sample; long prompt; all modes | Clear validation, preserved user intent/constraints, review before insertion, no auto-send |
| Card | Streaming/ready/error/stale; drag/resize/reset/minimize; viewport changes; library open | Composer usable; no stuck capture or detached controls; position restored sensibly |
| Keyboard | Tab/Shift+Tab through UI, Escape, shortcuts from unrelated text fields | Predictable focus; no unintended rewrite insertion, sending, saving or quota spend |
| Failure | Offline, 401, 429, provider rejection, stream interruption, cancel | Original retained, accurate error, no duplicate retry, no false completion |
| Memory | Save twice, search none, select context, unselect, delete | Accurate outcomes; no stale selected IDs or misleading success |
| Lifecycle | Reload extension while tab open; navigate chats; close/reopen browser | Recoverable update notice; no uncaught context errors; documented draft expiry |
| Privacy | Context off/on, tracking off/on, signed-out vs signed-in BYOK, voice cancel | Inspect request payloads for exactly the disclosed/authorized data; cancelled audio released |
| Platforms | ChatGPT, Claude, Gemini, Perplexity, Grok; narrow and wide composer layouts | Read/write intended composer only; no overlap with essential host controls |

Additional synthetic prompts:

1. “Explain recursion to a beginner in under 120 words, with one everyday analogy.” Preserve audience and word limit.
2. “Help me debug this fictional Python function: def add(a, b): return a - b. Explain the fix.” Preserve code; don't claim execution.
3. “Draft three playful names for a fictional plant shop. Avoid puns.” Preserve count and constraint.
4. Email sample from installation section: preserve names/days/length; never invent a reason or actually send an email.

Recruit five initial formative testers: three unfamiliar with API keys and two experienced users. Ask them to install, create a rewrite, correct it, find saved work, move the card and recover from a simulated error without coaching. Record completion, assistance, misunderstandings and perceived difficulty. This small sample discovers problems; it cannot establish conversion uplift or market demand. Establish a baseline before choosing time-to-first-value targets or running A/B tests. Product analytics, if later added, need a separate data-minimization and consent review; do not log raw prompts for funnel measurement.

## Execution order

1. Review the local website fixes in the real browser and verify the external download path.
2. Fix the Tab handler and test the card's keyboard/gesture/viewport lifecycle before more visual polish.
3. Unify first-run, context, BYOK and failure-state language; validate with fresh-profile tests.
4. Align remaining component styling and private dashboard behavior.
5. Run the cross-platform matrix, formative sessions and performance checks; fix blockers, then package and publish the reviewed build.

## What actually ran

- HTML parser checks: unique IDs, one main/h1, all same-page fragment targets and local linked pages exist: PASS.
- Contrast calculations for the two changed solid text/background pairs: PASS against 4.5:1. This does not cover every rendered element, gradient, theme or state.
- git diff --check: PASS.
- Existing standalone account-deletion contract suite: 5 PASS. This is backend regression coverage, not UI validation.
- Source review of landing page, privacy styling, popup setup, content-script card/keyboard logic, builder dashboard: completed with findings above.
- Local HTTP server: BLOCKED by environment socket-bind permission (PermissionError). No bypass attempted.
- Public website browser audit: PENDING public URL. No live visual, OAuth, provider, device, assistive-technology, Lighthouse or real-user testing completed in this review. No paid calls or real emails sent.

The existing extension static assertions are source-shape checks. Earlier static-check counts must not be interpreted as successful drag/resize interaction tests. The new website changes need a browser review before deployment.

## Follow-up: actual Chrome test, 15 September 2026

Chrome access succeeded in the follow-up session. This supersedes the earlier “no live testing” statement only for the checks listed here; the website itself remains untested without its URL.

- Opened the installed Prompt Memory popup: displayed v4.3 and connected account. Observed Ctrl shortcut labels on macOS and outdated instruction that ⊕ opens the sidebar.
- Opened a fresh Claude chat. Extension trigger rendered. Clicking it with empty composer displayed “Type a prompt in the chat input first.” PASS.
- Entered the fictional Alex email example and invoked Enhance once. Streaming rewrite completed; output preserved Tuesday→Thursday, under 100 words, and no invented reason. No message sent to Claude. PASS for this sample only; a signed-in enhancement may be retained in enhancement history under existing product behavior.
- With ready card and composer focused, pressed Shift+Tab. Actual result: composer was replaced by the rewrite and pill displayed “Inserted.” CONFIRMED keyboard navigation defect.
- Card was above the composer at the observed 1512×805 viewport. This one layout did not cover the send control. No resize handle appeared in the installed card's rendered UI; local resize implementation is not verified in this running copy despite the v4.3 label.
- Cleared the unsent synthetic composer text afterward. Did not send email, submit a Claude chat, alter account settings, or delete account/history data.
- API-key panel expansion was interrupted by a browser focus change; no conclusion about its expanded layout. Website, mobile, OAuth, other platforms, and resize tests remain pending.

## 16 September update: local 4.4 fixes

See [UI_UX_FIXES_4_4.md](UI_UX_FIXES_4_4.md) for the implementation and exact verification. The earlier Tab, shortcut scope, gesture lifecycle, layout-control, viewport and popup-copy findings now have local fixes. Browser verification of those fixes is pending manual reload because automatic browser review blocked the extension-management URL. Other roadmap items remain open.
