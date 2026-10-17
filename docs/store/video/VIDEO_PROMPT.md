# Prompt Memory: product video

A 35-second product video for the Chrome Web Store listing (the store takes
a YouTube link) and social posts. Five reference frames are in this folder,
captured from the real extension (`capture_frames.py` regenerates them):

| Frame | Shows |
|---|---|
| `frame-1-rough-draft.png` | A rough draft typed in a dark chat app; the ⊕ Improve button in the corner |
| `frame-2-rewrite-card.png` | The card with the clear rewrite, Replace draft, Shorter, Open-ended |
| `frame-3-context-retry.png` | The context list: two picked prompts left out, "Retry without them" |
| `frame-4-save-selection.png` | Part of an answer selected, the "＋ Save as context" button beside it |
| `frame-5-slash-insert.png` | `//rev` typed, the saved prompt list at the cursor |

AI video models draw readable interface text badly. Use them for the
frame-to-motion animation (image-to-video, one clip per frame) and the
title cards; keep the real frames for anything a viewer must read.

---

## 1. Master prompt (text-to-video, or the brief for an editor)

```
A 35-second, 16:9, 1080p product demo for "Prompt Memory", a Chrome extension that turns a rough prompt into a clear one inside AI chat apps. Clean, modern SaaS style: a dark chat interface (near-black #1b1b1b background, light grey text), mint green accent (#50C8A8) with a mint-to-blue-to-violet gradient (#38CDAF, #4B97CA, #7159EB) on the brand mark, a round ⊕ plus icon in a rounded square. Smooth, calm camera: slow push-ins and gentle pans across a laptop screen, no shaky motion, no people's faces. Soft ambient light, subtle depth of field, crisp UI. Minimal, confident motion graphics; on-screen captions in a clean sans-serif (Inter or Segoe-like), white with mint highlights.

Scene 1 (0-5s): Close on a chat window. A cursor types a messy question into the message box: "hw do i sort a list of dicts by a key in python, some dont have the key". Caption: "You know what you mean."
Scene 2 (5-11s): The cursor clicks a small glowing ⊕ "Improve" button in the bottom corner. A dark card slides up above the message box; a clear, well-structured prompt streams into it word by word. Caption: "One click. A clear prompt."
Scene 3 (11-16s): The cursor clicks "Replace draft"; the clear prompt flows into the message box. Small buttons "Shorter" and "Open-ended" pulse once. Caption: "Your words, sharpened. Try another style."
Scene 4 (16-23s): The card's context list opens: three saved items, two get struck through, a mint "Retry without them" button glows and is clicked. Caption: "See what shaped it. Leave out what doesn't fit."
Scene 5 (23-29s): The camera moves to an AI answer in the chat; text is highlighted and a small "+ Save as context" pill appears and is clicked. Then in the message box someone types "//rev" and a saved prompt appears at the cursor. Caption: "Save what matters. Reuse it anywhere with //."
Scene 6 (29-35s): Pull back; the ⊕ mark centred on a dark background with the mint-violet gradient, a soft light sweeping once around the ring. Title: "Prompt Memory". Subtitle: "Better prompts, one click. Right in ChatGPT, Claude, Gemini, Perplexity and Grok." Small text: "Free on the Chrome Web Store."

Music: light, modern electronic, 100-110 BPM, warm synth pads, subtle percussion, builds slightly at scene 5, resolves on the logo. No lyrics.
```

## 2. Per-frame prompts (image-to-video)

Upload each frame as the start image, 5 seconds each, then cut them together.
Keep the motion small so the interface text stays sharp.

**Frame 1** (`frame-1-rough-draft.png`)
```
Subtle slow push-in towards the message box at the bottom. A text cursor blinks at the end of the typed message. A soft mint glow pulses once around the small "Improve" button in the bottom-right corner. Everything else stays still. No new text, no distortion of the existing text.
```

**Frame 2** (`frame-2-rewrite-card.png`)
```
The dark card above the message box rises 20 pixels into place and settles, as if it just slid up. A faint mint highlight sweeps once across the rewritten text from left to right. Gentle slow zoom on the card. Keep all text sharp and unchanged.
```

**Frame 3** (`frame-3-context-retry.png`)
```
Slow push-in on the list in the middle of the card. The mint "Retry without them" button glows softly and pulses once, as if about to be clicked. The struck-through rows stay dimmed. No other motion; keep text legible.
```

**Frame 4** (`frame-4-save-selection.png`)
```
The blue text selection holds steady; the small dark "+ Save as context" pill below it scales in gently from 90% to 100% and its plus icon glows mint once. Very slight camera drift to the right. Text stays crisp.
```

**Frame 5** (`frame-5-slash-insert.png`)
```
The small list above the message box fades in and rises slightly; the "Code review template" row gets a soft highlight. A cursor blinks after "//rev". Slow push-in toward the message box. No added text.
```

**Logo end card** (use `../logo-512.png` or `../promo-marquee-1400x560.png`)
```
The ⊕ logo on a dark background. A thin point of mint light travels once around the white ring with a short comet tail, then the logo settles with a soft glow. Minimal, premium, calm. 4 seconds.
```

## 3. Captions and voice-over (optional)

| Time | Caption | Voice-over |
|---|---|---|
| 0-5s | You know what you mean. | You know what you mean. The AI doesn't always. |
| 5-11s | One click. A clear prompt. | Press Improve, and your rough draft becomes a clear prompt. |
| 11-16s | Try another style. | Use it, or make it shorter, or more open-ended. |
| 16-23s | See what shaped it. | See what context it used, and leave out what doesn't fit. |
| 23-29s | Reuse it anywhere with //. | Save anything worth keeping, and bring it back with two slashes. |
| 29-35s | Prompt Memory | Prompt Memory. Better prompts, one click. Free for Chrome. |

## 4. Store requirements

- The Chrome Web Store takes the video as a **YouTube URL** (Store listing →
  "Video", optional). Upload it to YouTube as Public or Unlisted first.
- Show the product honestly: what the video shows must be what the
  extension does. Do not show other companies' logos (OpenAI, Anthropic,
  Google) as if they endorse it; the frames use a neutral chat page for that
  reason.
