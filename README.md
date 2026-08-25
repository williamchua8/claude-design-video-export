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

## The problems this fixes

### 1. A section of the screen blinks for a moment

**What it looks like.** Not a blank frame — for one frame, *part* of the
composition fails to paint. In a real 4K/30 export from the previous script,
frame 1362 lost the whole `HQ-Core` row and three KPI numbers, and drew a flat
grey rectangle where they should have been. Frames 1361 and 1363 are both
correct and identical to each other. At 30 fps that reads as a UI element
blinking.

**Cause.** A partial-paint race: the frame was serialised before that subtree
finished rasterising.

**Fix, in two layers.**

*Compositor flags* (`lib/browser.js`, `--paint-determinism`) remove the async
paint paths. They are **off by default**, and not for speed — they measured
slightly faster. `--run-all-compositor-stages-before-draw` can deadlock the
screenshot call outright: the compositor waits for a main-frame update that
never arrives, because the virtual clock owns `requestAnimationFrame` and a
pinned scene schedules no animation of its own. That showed up here as a 120 s
screenshot timeout, which is a stalled render rather than a bad frame. Since the
sweep below is the real guarantee, the trade was a stall risk against an
unmeasured benefit, so they stay opt-in.

*The dropout sweep* (`lib/sweep.js`) is the guarantee, and it runs by default.
After capture it scans every frame for one specific signature:

```
frame i differs a lot from i-1
frame i differs a lot from i+1
but i-1 and i+1 agree closely with each other     <- content left and came back
```

Under real motion, `i-1` and `i+1` are the *furthest* apart of the three pairs,
never the closest, so ordinary animation cannot trigger it. Flagged frames are
re-rendered, and the re-render is kept **only if it is measurably more
consistent with its neighbours** — a frame that reproduces identically is
authored content, so the original is put back untouched. Nothing loops, and
nothing is silently changed.

Validated against the real export: run over 50 frames of that video it found
frame 1362 and nothing else — one true positive, zero false positives.

Because dropouts are rare, the sweep is cheap: capture and encode still overlap,
and a second encode pass happens only if a frame was actually repaired.

### 2. Wall-clock motion (stutter on ambient elements)

Frame-by-frame seeking is only correct for motion that is a pure function of the
seek time. Anything on the **wall clock** — a CSS `@keyframes` loop, a shimmer, a
`requestAnimationFrame` ticker, a `<video>` — keeps advancing on real time, and
during capture real time does not advance at `1/fps`: one frame takes 900 ms
because the layer tree is cold, the next 180 ms, then a GC pause costs 700 ms.
Each such element lurches forward by a random amount every frame.

Every clock in the page is replaced before any page script runs
(`performance.now`, `Date.now`, `Math.random`, `requestAnimationFrame`) and
stepped to exactly `i/fps`; every CSS animation, transition and media element is
then pinned to that instant through the Web Animations API. The same timestamp
renders to byte-identical pixels regardless of how long the machine took to get
there — verified in `test/selftest.js`, including that two independent workers
agree (otherwise you get flicker at the seams between their frame ranges).

You do **not** need to re-author your animation for this.

```
--time absolute   (default) pin every animation to the seek time
--time replay     also step through the timeline, so an element that mounts
                  mid-scene starts its transition at the right moment
--time off        no virtual clock — reproduces the original stutter
```

### 3. A radial glow that exports as a rectangle

**Being straight with you: I could not reproduce this.** I rendered your actual
bundle at 1080p, 1440p, 4K native and 4K supersampled, under GPU and software
raster, and under both scale modes. Every one produced the same, correct, radial
glow. I also tested the specific mechanism I suspected — Claude Design renders
everything inside an SVG `<foreignObject>`, which is a known Chromium
filter-clipping path — by re-parenting the live content into plain DOM and
re-rendering. **Mean pixel difference: 0.** The foreignObject is not the cause.

That points at your graphics driver. The test machine here is Linux on
SwiftShader; you are on Windows with AMD graphics, and the previous script
hardcoded `--use-angle=d3d11`. A large-sigma blur mis-rasterising is exactly the
kind of thing that is driver-specific — and it would explain why supersampling
and the software/GPU toggle made no difference for you, since neither changes
the ANGLE backend.

So rather than ship a fix for a cause I could not confirm, the tool gives you the
means to identify it on your own machine:

```bash
node render.js --input project.zip --action doctor
```

The doctor renders **the same instant under five render paths** that differ only
in how the page is rasterised, including `--angle swiftshader`, which uses
ANGLE's own CPU rasteriser and involves no vendor driver at all. It then compares
them **against each other**.

That comparison is the whole point. An absolute "is this glow round" measurement
is worthless here and the tool no longer pretends otherwise — a rectangular panel
legitimately has a rectangular halo, so a high anisotropy number can be perfectly
correct. But identical content through different graphics paths must look
identical. Where two disagree, one is wrong.

If `D-angle-swiftshader` is the one that looks right, it is your driver, and
`--angle swiftshader` renders correctly at some cost in speed:

```bash
node render.js --input project.zip --res 4k --angle swiftshader
```

Backends available: `default`, `d3d11`, `d3d9`, `gl`, `vulkan`, `swiftshader`.

### 4. Slow, wasteful exporting

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

## Rendering part of a project

A Claude Design piece is one continuous timeline made of named sections, and a
`.zip` from Claude Code often holds several separate compositions. You rarely
want all of it.

**Several videos in one zip.** Every bundle in the project is detected and you
are asked which one to render (or pass `--entry`). The chosen one's name goes
into the output filename so exports do not collide.

**Sections within one video.** The composition declares its own scene list, which
the tool reads straight out of the bundle:

```bash
node render.js --input project.zip --list-scenes
```

```
   1) Silos        0.0s – 5.0s   (5s, 150 frames)
        Five vendor devices drop in above a dark campus grid…
   2) Unify        5.0s – 11.0s  (6s, 180 frames)
   3) OnePane     11.0s – 20.0s  (9s, 270 frames)
   4) MultiSite   20.0s – 32.0s  (12s, 360 frames)
   5) IPAM        32.0s – 47.0s  (15s, 450 frames)
   6) Close       47.0s – 52.0s  (5s, 150 frames)
   total 52s
```

Then render only what you need — by name, number, range or list:

```bash
node render.js --input project.zip --scene IPAM
node render.js --input project.zip --scene 3
node render.js --input project.zip --scene 2-4
node render.js --input project.zip --scene "ipam,close"
```

Re-cutting one 15-second scene renders 450 frames instead of 1560. Frames for a
scene are cached under their own key, so they are never confused with a full
render sitting in the same project.

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

# One scene only, from a project containing several videos
node render.js --input project.zip --entry scene-2/index.html --scene IPAM

# A glow renders wrongly on this machine but not elsewhere
node render.js --input project.zip --res 4k --angle swiftshader
```

Run `node render.js --help` for the full flag list.

---

## Troubleshooting

**"Glows are still square."** Run the doctor. If it reports
`chrome-headless-shell`, run `npx playwright install chromium`. If it reports the
full build and variant **A** still looks wrong while **C** (software raster)
looks right, use `--software`.

**"An element blinks for a moment."** That is the paint dropout described above,
and the sweep catches it automatically. If you disabled it with `--no-sweep`, turn
it back on. If it persists, `--jobs 1` reduces compositor pressure.

**"Capture is slower than I expected."** A composition authored at 4K lays out at
3840 css px whatever resolution you export, so layout cost is the same at 1080p
as at 4K — only rasterisation gets cheaper. Throughput is dominated by your GPU
and core count. Use `--action preview` to time a short slice before committing to
the whole timeline, and `--scene` to avoid re-rendering parts you have not
changed.

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
| `lib/scenes.js` | Reads the composition's scene list; resolves `--scene` |
| `lib/sweep.js` | Paint-dropout detection and repair |
| `lib/pixels.js` | Glow measurement |
| `lib/doctor.js` | The diagnostic suite |
| `test/selftest.js` | End-to-end checks against deliberately broken fixtures |

```bash
npm run selftest
```

### Why the input is served over HTTP

Projects are served from a short-lived local HTTP server rather than opened with
`file://`. `file://` blocks ES module imports, `fetch()` and some font loads under
Chromium's origin rules, so a multi-file project that works when you double-click
it can still half-load under `file://` — and a half-loaded project renders as
missing text or missing panels.
