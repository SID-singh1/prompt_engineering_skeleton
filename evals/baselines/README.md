# Production baselines

This directory stores small, manually verified production samples that are useful for regression analysis. They contain synthetic prompts only—never API keys, access tokens, personal conversation history, or saved-prompt context.

`chrome_shared_2026-09-11.json` was captured through the real Chrome extension on ChatGPT. Every scored source value was verified in the composer before enhancement. The excluded code case documents a browser automation input failure and is intentionally not treated as model evidence.

## 2026-09-11 findings

- 11 corpus cases reached the production model with verified input; one additional fully specified case was also tested.
- 7 of 11 corpus outputs passed the current deterministic gates (63.6%). The
  already-clear, vague/deep, research, and numeric cases exceeded their
  category length bounds; the numeric miss was only one word, but remains a
  failure under the frozen gate.
- One semantic hard failure remained: `numbers-001` invented a technical interview domain.
- At least five other outputs added optional scope the user did not request. The most visible examples were mandated launch channels, named countries and industries, grief/loss framing, a ban on code examples, and extra TCP/UDP comparison dimensions.
- Strong areas were rewriter-vs-responder behavior, prompt-injection resistance, Hinglish script preservation, filler removal, negative constraint retention, and exact numeric retention.
- The Chrome integration corrupted one multiline code prompt during automated text replacement. Because corruption occurred before enhancement, it is not evidence against the rewriter model; it is a separate content-editable/input-path risk worth covering with an end-to-end test.

The deterministic pass rate should not be read as the complete quality score.
Deterministic gates catch literal violations, while intent-changing assumptions
require semantic review. This run demonstrates why both layers are necessary.
