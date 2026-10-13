// ══════════════════════════════════════════════════════════════
// SITES: what each chat site's page looks like, in one place
// ══════════════════════════════════════════════════════════════
//
// ChatGPT, Claude and Gemini change their markup without notice. Twice in one
// week of October 2026 the chat box or the messages moved: ChatGPT put its
// controls on the text's row and dropped data-message-author-role, and Claude
// moved add-to-context into a menu. Each time the fix was a selector somewhere
// in a 7,000-line content.js. Every selector the extension reads a chat page
// with now lives here, so the next change is an edit to this file.
//
// Loaded before content.js (manifest content_scripts, and the test harnesses),
// in the same isolated world: content.js reads PM_SITES. Geometry heuristics
// (where a box's frame or Send row is) stay in content.js; they measure what
// these selectors find rather than naming anything.

// eslint-disable-next-line no-unused-vars
const PM_SITES = Object.freeze({
  // The chat box. Ordered most- to least-specific. querySelector returns the
  // FIRST match in document order, which on several of these sites is a hidden
  // search box or an off-screen editor, so content.js checks each candidate is
  // visible before taking it.
  composer: Object.freeze([
    "#prompt-textarea",                          // ChatGPT
    "div[contenteditable='true'][role='textbox']",
    "[data-testid='chat-input'] [contenteditable='true']",
    "form [contenteditable='true']",
    "form textarea",
    "[contenteditable='true']",
    "textarea",
  ]),

  // Where a prompt is typed, for prompt tracking (off unless the user turns it on).
  typingTarget: "#prompt-textarea, [contenteditable='true'], textarea",
  // Hosts the extension serves on one path only. x.com matches only /i/grok in
  // the manifest, but a content script keeps running after a same-page route
  // change, so the path is checked again before anything is tracked.
  onlyPaths: Object.freeze({ "x.com": "/i/grok" }),

  // A message the user sent, for the bookmark beside it. ChatGPT marks the
  // user's side two ways depending on the build: the old author role, and
  // (live since 2026-10) a bubble with a user-toned text inside. Gemini uses
  // user-query; Claude a test id.
  sentPrompt: '[data-message-author-role="user"], [data-user-message-bubble], ' +
    '[data-markdown-text-tone="user-message"], user-query, [data-testid="user-message"]',
  // The element holding a sent message's words: Gemini wraps them inside its user-query.
  sentPromptWords: '[data-markdown-text-tone="user-message"], .query-text',
  // Text a screen reader hears and the eye does not: Gemini starts every one of
  // your messages with a hidden "You said", which is not part of the prompt.
  visuallyHidden: '.cdk-visually-hidden, .sr-only, [class*="visually-hidden"]',

  // How to read the visible conversation for context, per host. `messages`
  // finds them in page order; `role(el)` says whose each is. `nested: true`
  // skips an element inside one already taken (ChatGPT marks both a message
  // and parts of it).
  conversation: Object.freeze({
    // ChatGPT dropped data-message-author-role (seen live, 2026-10-01): the
    // two sides are now marked on their text, as a user "tone" and an
    // assistant "style". Both markings are read.
    "chatgpt.com": Object.freeze({
      messages: "[data-message-author-role], [data-markdown-text-tone='user-message'], [data-markdown-text-style='assistant-message']",
      nested: true,
      role: (el) => el.getAttribute("data-message-author-role") ||
        (el.getAttribute("data-markdown-text-tone") === "user-message" ? "user" : "assistant"),
    }),
    "claude.ai": Object.freeze({
      messages: "[class*='Message'], [data-testid*='message']",
      role: (el) => (el.className?.includes("human") || el.getAttribute("data-testid")?.includes("human") ? "user" : "assistant"),
    }),
    // Gemini distinguishes the two sides in the DOM, so they are tagged.
    "gemini.google.com": Object.freeze({
      messages: "message-content, .model-response-text, .query-text",
      role: (el) => (el.classList.contains("query-text") || el.closest(".query-text") ? "user" : "assistant"),
    }),
    "grok.com": Object.freeze({
      messages: "[class*='message'], [class*='Message'], [data-testid*='message'], [class*='response'], [class*='query']",
      role: (el) => {
        const cls = `${el.className || ""} ${el.getAttribute("data-testid") || ""}`.toLowerCase();
        return cls.includes("query") || cls.includes("user") || cls.includes("human") ? "user" : "assistant";
      },
    }),
  }),
  // Grok inside x.com reads as grok.com does.
  conversationAliases: Object.freeze({ "x.com": "grok.com" }),
  // Any other site: messages of unknown role, tagged so the backend can tell
  // "not a user message" from "role unknown".
  conversationFallback: Object.freeze({
    messages: "[class*='message'], [class*='Message'], [role='presentation']",
    minLength: 6,
    maxLength: 1999,
  }),
});
