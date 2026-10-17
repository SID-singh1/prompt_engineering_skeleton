# Prompt Memory video: five 10-second clips

For an image-to-video generator that makes 10-second clips. Each clip has a
**start frame** (upload it as the first frame), an **end frame** (use it as
the last frame if the tool has a "first and last frame" option; if not, ignore
it, and cut the next clip so it starts on that same image), and a prompt.
Total: 50 seconds. Trim the last clip to 5 s for a 45-second video.

Frames are in this folder (1280×800; the end card is 1920×1080). Regenerate
them with `capture_frames.py`, `capture_end_frames.py`, `capture_end_card.py`.

| Clip | Time | Start frame | End frame | Story |
|---|---|---|---|---|
| 1 | 0-10 s | `frame-1-rough-draft.png` | `frame-2-rewrite-card.png` | A rough draft; one click; a clear rewrite appears |
| 2 | 10-20 s | `frame-2-rewrite-card.png` | `frame-2b-replaced.png` | Replace the draft; other styles; Undo |
| 3 | 20-30 s | `frame-3-context-retry.png` | `frame-3b-retried.png` | See the context; leave out what doesn't fit; Retry |
| 4 | 30-40 s | `frame-4-save-selection.png` | `frame-5-slash-insert.png` | Save text as context; reuse it with `//` |
| 5 | 40-50 s | `frame-6-end-card.png` | `frame-6-end-card.png` | Logo and tagline |

## Settings for every clip

- 16:9, 1080p, 10 seconds, no audio (add music and voice-over when you compile).
- Camera: nearly still. A very slow push-in is the most you want; the more the
  camera or the interface moves, the more the small text warps.
- Add this to the end of every prompt:

```
Keep all interface text exactly as in the image: do not rewrite, blur, translate or add any text. No people, no hands, no logos of other companies. Calm, smooth motion. Photoreal screen capture look, crisp UI, dark theme.
```

- Negative prompt, if the tool has one: `warped text, garbled letters, flicker, extra buttons, new UI elements, camera shake, watermark, subtitles`

---

## Clip 1 (0-10 s): the rough draft becomes a clear prompt

Start `frame-1-rough-draft.png`, end `frame-2-rewrite-card.png`.

```
A dark AI chat window on a laptop screen. A rough message sits in the message box at the bottom: "hw do i sort a list of dicts by a key in python, some dont have the key". A small button labelled "Improve", with a green plus-in-a-circle icon, glows softly in the bottom-right corner. The slow camera drifts in towards the message box. At about 4 seconds the Improve button is clicked: it flashes mint green once. A dark rounded card slides up from just above the message box and settles. A clear, well-written prompt appears inside it, beginning "Show me how to sort a list of dictionaries in Python by a specific key", with a green "Replace draft" button beneath. The card ends exactly as in the final image.
```

Caption to add: **You know what you mean.** (0-4 s) then **One click. A clear prompt.** (5-10 s)

## Clip 2 (10-20 s): use it, or try another style

Start `frame-2-rewrite-card.png`, end `frame-2b-replaced.png`.

```
The dark rewrite card above the chat message box, showing a clear prompt, with a green "Replace draft" button and two outlined buttons, "Shorter" and "Open-ended". Slow, gentle push-in. At about 2 seconds the "Shorter" and "Open-ended" buttons each pulse softly once. At about 5 seconds "Replace draft" is clicked: the card fades down and away, and the clear prompt appears in the message box at the bottom, replacing the rough text. A small dark pill in the bottom-right corner reads "Replaced" with an "Undo" button and thumbs up and down icons. It ends exactly as in the final image.
```

Caption to add: **Use it, or try another style.** (10-16 s) then **Undo any time.** (16-20 s)

## Clip 3 (20-30 s): see what shaped it, leave out what doesn't fit

Start `frame-3-context-retry.png`, end `frame-3b-retried.png`.

```
A dark rewrite card above a chat message box. Inside it a list titled "Context for this rewrite" shows three rows: the first is "Code review template" with a "Don't use" button; the other two, "Bug report triage" and a past prompt, are dimmed and struck through, each with a small green "Use" button. Below the list: "2 left out. Nothing is searched again." with a green "Retry without them" button. Slow push-in on the list. At about 4 seconds the green "Retry without them" button is clicked and pulses once. The card refreshes with a short shimmer: the list now shows only "Code review template" and a line "Left out: Bug report triage, Past prompt: sort dicts python", and the title bar shows "2 of 2". It ends exactly as in the final image.
```

Caption to add: **See what shaped it.** (20-25 s) then **Leave out what doesn't fit. Retry.** (25-30 s)

## Clip 4 (30-40 s): save anything, reuse it with //

Start `frame-4-save-selection.png`, end `frame-5-slash-insert.png`.

```
First half (0-5 s): a dark chat page. A paragraph from an AI answer is highlighted in blue: "Use sorted() with a key function that reads the signup date..." A small dark pill labelled "+ Save as context" sits just below the highlight. The camera pushes in slowly. The pill is clicked and flashes mint green once, the highlight fades. Second half (5-10 s): the camera settles on the empty message box at the bottom. The words "Before I merge, can you //rev" are typed. A small dark list rises above the box with one row, "Code review template", highlighted, with the hint "Enter insert · Tab attach · esc". It ends exactly as in the final image.
```

Caption to add: **Save what matters.** (30-35 s) then **Bring it back anywhere with //.** (35-40 s)

## Clip 5 (40-50 s): end card

Start and end `frame-6-end-card.png`.

```
A dark, minimal end card. A rounded-square app icon with a mint-to-blue-to-violet gradient and a white plus inside a ring floats in the centre, with a soft mint glow behind it. Slow, subtle push-in. At about 3 seconds a thin point of mint light travels once around the white ring with a short comet tail and fades. The words "Prompt Memory" and "Better prompts, one click." and "Free on the Chrome Web Store" stay perfectly still and sharp. Calm, premium, no other motion.
```

Caption: none (the text is in the image).

---

## Compiling

1. Put the five clips on one timeline in order. Use 0.3 s cross-dissolves, or
   hard cuts, between them. Because each clip ends on the next one's start
   frame (clip 1 → 2 on `frame-2`), the joins should look continuous.
2. Add captions in the editor (CapCut, DaVinci Resolve, Descript), not in the
   generator: clean sans-serif, white, mint (#50C8A8) for the key words,
   lower third. The generator will garble them.
3. Music: light modern electronic, 100-110 BPM, no vocals, quiet under any
   voice-over, a little lift at clip 4.
4. Voice-over (optional), one line per clip:
   1. "You know what you mean. The AI doesn't always."
   2. "Press Improve, replace your draft, or try another style."
   3. "See what context it used, and leave out what doesn't fit."
   4. "Save anything worth keeping, and bring it back with two slashes."
   5. "Prompt Memory. Better prompts, one click."
5. Export 1080p, upload to YouTube (Unlisted is fine), and paste the link into
   the Chrome Web Store listing's Video field.

## If the text keeps warping

Text is the weak point of these generators. A reliable fallback for any clip:
screen-record the real extension doing the same steps (Windows: Win+G, or
OBS; Mac: Cmd+Shift+5), speed the dull parts up, and use the generator only
for clip 5. The screenshots show exactly what to do on screen.
