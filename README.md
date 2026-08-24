# Claude Design → MP4

Render a Claude Design animation to a high-quality video, without the stutter,
soft text and boxy glows that frame-by-frame exporters usually produce.

Point it at whatever Claude gave you — a standalone `.html`, a project folder, or
the `.zip` from Claude Code. Nothing has to be restructured or re-authored.

```bash
npm install          # once — pulls Chromium and a bundled ffmpeg
node render.js       # interactive menu
```

---

## Start here: `Diagnose quality`

If something already looks wrong, run this before rendering anything long. It
renders **the same frame under four different configurations**, measures what can
be measured, and writes a side-by-side HTML report:

```bash
node render.js --input my-project.zip --action doctor
```

It answers four questions that are almost impossible to judge from a finished
mp4:

| Check | What it catches |
|---|---|
| **Browser build** | `chrome-headless-shell` — the single most common cause of square glows |
| **Blur / glow** | Measures whether your glows are radial or clipped to a rectangle |
| **Determinism** | Whether anything in the composition is still moving on the wall clock |
| **Frame cadence** | Whether your chosen fps is duplicating frames (which reads as judder) |

Open `diagnosis/report.html`, compare the four images, and use the flags printed
under whichever one looks right.

---

## The three problems this fixes

### 1. Stutter and "visual lag" on some elements

**Cause.** A frame renderer seeks the composition to `t = i/fps` and screenshots.
That is only correct for motion that is a pure function of the seek time.
Anything driven by the **wall clock** — a CSS `@keyframes` ambient loop, a
shimmer, a pulsing glow, a `requestAnimationFrame` ticker, a spring library, a
`<video>` — keeps advancing on real time.

During capture, real time does not advance at `1/fps`. Frame 0 takes 900 ms
because the layer tree is cold, frame 1 takes 180 ms, frame 2 takes 240 ms, and a
GC pause makes frame 3 take 700 ms. Every wall-clock-driven element therefore
lurches forward by a different, random amount on every frame. Played back at a
constant 60 fps, that is exactly what stutter looks like.

No bitrate fixes this. The frames themselves are inconsistent.

**Fix.** The renderer replaces every clock in the page before any page script
runs — `performance.now`, `Date.now`, `Math.random`, `requestAnimationFrame` —
with one virtual clock it steps to exactly `i/fps` per frame. It then pins every
CSS animation, CSS transition and `<video>` to that same instant through the Web
Animations API.

The result is that **the same timestamp renders to byte-identical pixels every
time**, no matter how long the machine took to get there. That is verified in
`test/selftest.js`, including a check that two independent parallel workers
produce the same frame (otherwise you get flicker at the seams between their
ranges).

You do **not** need to rewrite your animation to make this work. Ambient CSS
loops, rAF tickers and third-party animation libraries are all handled.

```
--time absolute   (default) pin every animation to the seek time
--time replay     also step through the timeline, so an element that mounts
                  mid-scene and transitions in starts its transition at the
                  right moment
--time off        no virtual clock — reproduces the original stutter
```

### 2. A radial glow that exports as a square

There are two independent causes, and the doctor tells you which one you have.

**Cause A — the headless shell.** Playwright and Puppeteer both ship two
Chromium binaries. `chrome-headless-shell` is the small, cut-down one, and it
mis-composites `filter: blur()` and `backdrop-filter` when they sit under a
transform, clipping them to the element's rectangular layer bounds. Puppeteer's
`headless: true` and the deprecated `headless: 'new'` do not reliably get you the
full build across versions — which is how a script can work for months and then
start producing square glows after a routine dependency bump.

This renderer explicitly requests a full Chromium, then **verifies what it
actually got** and warns loudly if it landed on the shell.

**Cause B — scaling the stage instead of the device.** There are two ways to
render a 1920×1080 composition at 4K, and they are not equivalent:

- **`--scale-mode dpr`** (default). The viewport stays at the authored size and
  `deviceScaleFactor` goes to 2. The stage lays out at scale 1.0 and Chromium
  rasterises the whole page at 2× density — blur radii, radial gradients, shadows
  and text all computed at full output resolution, exactly as on a retina
  display.
- **`--scale-mode layout`**. The viewport is set to 3840 px and the stage scales
  *itself* up 2× with a CSS transform. Fine for a flat rectangle. Not fine for a
  `filter: blur(140px)` glow inside a `preserve-3d` subtree: the raster scale gets
  clamped, the blur is computed on a smaller surface and then magnified, and a
  soft radial falloff degrades into visible steps or a flat box.

Most hand-rolled export scripts do the second one. This one defaults to the
first.

**How the measurement works.** A true radial glow fades out at the same distance
in every direction. A glow clipped to its box reaches √2 further into the corners
than along the axes. The doctor reports that ratio — **~1.0 is radial, ~1.41 is
clipped**. The measurement is validated in the test suite against a fixture
holding two identical glows, one of them deliberately inside `overflow: hidden`
(it measures 1.00 and 1.38 respectively), so a "radial (correct)" verdict means
something.

### 3. Slow, wasteful exporting

- **Capture and encode run at the same time.** A feeder walks the frames in order
  and pushes them into a long-lived ffmpeg on stdin, so the mp4 finishes seconds
  after the last frame is captured instead of minutes later.
- **Frames are still written to disk**, so an interrupted run resumes exactly
  where it stopped. Speed is not traded for that.
- **Resume is trustworthy.** A frame counts as done only if it is a structurally
  complete PNG — a file truncated by a crash is detected and re-rendered, not
  baked into the master.
- `--reap` deletes each frame once it has been encoded, if disk is tight.

---

## Encoder settings, and why

**CRF, not a bitrate target.** A flat dark motion-graphics frame with thin
high-contrast text is the worst case for average-bitrate encoding: most of the
frame is nearly free, so the encoder reports plenty of headroom while the few
busy edge blocks starve. That is what reads as soft glyphs and colour fringing
around text. The default is CRF 16 with no cap at all.

**`aq-mode=3`** moves bits into large flat dark regions, where gradient banding
shows, without stealing them from text edges.

**Explicit colour range.** PNG frames are full-range RGB; H.264 for delivery is
limited-range YUV. Convert without saying so and ffmpeg's default and the
player's assumption can disagree by exactly one range expansion, giving you milky
blacks or crushed shadows. Both ends are stated explicitly and the file is tagged
to match — you should see `yuv420p(tv, bt709)` on the output.

**4:2:0, not 4:4:4.** High 4:4:4 Predictive removes chroma fringing on text, but
sits outside the H.264 feature set QuickTime, Windows Media Foundation,
VideoToolbox and most hardware decoders support — they refuse it or decode
garbage blocks. ffmpeg's own software decoder plays it perfectly, which is
exactly why it can look fine right up until a normal player opens it.

**Deband is off by default.** At the strengths usually copied off the internet
(`gradfun=20:30`) it draws a soft rectangular halo around sharp UI text and
visibly blurs thin lines — fixing banding your composition may not have while
creating a text-softness problem it does. Available as `--deband` if you need it.

### Quality profiles

| `--quality` | What it is | Use for |
|---|---|---|
| `master` *(default)* | H.264 CRF 16, High profile | Almost everything |
| `delivery` | H.264 CRF 18 + bitrate cap | YouTube / social upload specs |
| `h265` | HEVC 10-bit CRF 20 | Smallest at equal quality; 10-bit kills gradient banding |
| `prores` | ProRes 422 HQ | Handing to Premiere / Resolve / FCP |

---

## Common recipes

```bash
# The usual: 4K60 master from a zip
node render.js --input project.zip --res 4k --fps 60

# Something looks wrong — find out what, before rendering 40 minutes of frames
node render.js --input project.zip --action doctor

# Check settings on a 2-second slice first
node render.js --input project.zip --action preview

# Maximum sharpness: capture at 2x and lanczos-downscale
node render.js --input project.zip --res 4k --ss 2

# An element mounts mid-timeline and its transition looks wrong
node render.js --input project.zip --time replay

# Edit-ready master with a voiceover baked in
node render.js --input project.zip --quality prores --audio voiceover.mp3

# Resume an interrupted render
node render.js --input project.zip --action fill
```

Run `node render.js --help` for the full flag list.

---

## Troubleshooting

**"Glows are still square."** Run the doctor. If it reports
`chrome-headless-shell`, run `npx playwright install chromium`. If it reports the
full build and variant **A** still looks wrong while **C** (software raster)
looks right, use `--software`.

**"Some elements still jitter."** The doctor's determinism check will say whether
frames are still non-reproducible with the virtual clock on. If they are,
something is out of the clock's reach — a WebGL/canvas loop, a Web Worker, or a
media element. Try `--freeze-timers`, then `--time replay`.

**"The video judders even though every frame looks right."** Check the doctor's
frame cadence section. If a third or more of consecutive frames are byte-identical,
the composition updates more slowly than the fps you asked for and the export is
duplicating frames. Render at a rate it actually hits.

**"Text is soft."** You are probably exporting below the authored resolution.
Either export at native size or add `--ss 2`.

**"It runs out of disk."** Add `--reap`.

---

## How it is put together

| File | Responsibility |
|---|---|
| `render.js` | CLI, interactive menu, config |
| `lib/input.js` | `.html` / folder / `.zip` input, dependency-free unzip, static server |
| `lib/probe.js` | Detects the bundle type and reads size / duration off it |
| `lib/determinism.js` | The virtual clock — the stutter fix |
| `lib/browser.js` | Launch, full-Chromium enforcement — half the glow fix |
| `lib/capture.js` | Render geometry — the other half — and the worker pool |
| `lib/frames.js` | Atomic writes and structural PNG validation (resume) |
| `lib/encode.js` | ffmpeg filter chain and encoder settings |
| `lib/pipeline.js` | Runs capture and encode concurrently |
| `lib/pixels.js` | Glow measurement |
| `lib/doctor.js` | The diagnostic suite |
| `test/selftest.js` | 12 end-to-end checks against deliberately broken fixtures |

```bash
npm run selftest
```

### Why the input is served over HTTP

Projects are served from a short-lived local HTTP server rather than opened with
`file://`. `file://` blocks ES module imports, `fetch()` and some font loads under
Chromium's origin rules, so a multi-file project that works when you double-click
it can still half-load under `file://` — and a half-loaded project renders as
missing text or missing panels.
