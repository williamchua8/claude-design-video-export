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

**What it looks like.** Not a blank frame — for a moment, *part* of the
composition fails to paint. In a real 3840x2160/30 export, frames **1357–1358**
(t = 45.2 s) both lost the whole `ADDRESS BLOCKS` panel; the rest of the layout
reflowed up into the space it left. Frames 1356 and 1359 are correct and
identical to each other. At 30 fps that reads as the UI blinking.

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
After capture it scans every frame for one specific signature — stated over a
**run** of 1 to 4 frames, not a single frame:

```
the frame entering the run differs a lot from the one before it
the frame after the run differs a lot from the last one in the run
but the frames BRACKETING the run agree closely with each other
and the frames INSIDE the run agree closely with each other
                                        <- content left and came straight back
```

**Runs are the fix for the artefact that survived the first version.** The
original test asked whether frame *i* differed from both of its neighbours. For
a two-frame dropout that test can never fire: frame 1357's next neighbour is
1358, the second half of the same dropout, so they agree and it is skipped —
and 1358 is skipped for the same reason looking backwards. The artefact is twice
as visible as a one-frame blink and was invisible to the detector.

```
1356  panel present
1357  panel gone      <-- mad(1357,1356) = 6.61
1358  panel gone      <-- mad(1358,1357) = 0.15   <<< what the old test tripped on
1359  panel present   <-- mad(1359,1358) = 6.60
```

Under real motion the bracketing frames are the *furthest* apart of the set,
never the closest, so ordinary animation cannot trigger this however fast it
moves. A longer run needs a proportionally cleaner signature before it is
believed, which keeps short authored inserts out.

Flagged frames are re-rendered — **serially, with a longer settle**, since the
artefact is a race and re-running it under the conditions that lost the race is
the one approach guaranteed to be unconvincing. The re-render is kept **only if
it is better on every axis**: the run now blends into what brackets it, and
neither boundary got worse. A run that reproduces identically is authored
content, so the original is put back untouched. Nothing loops, and nothing is
silently changed.

**Validated against real footage.** Across two 1560-frame 4K exports of the same
project it finds the two-frame dropout at 1357–1358 in one, the single-frame
dropouts at 1167 and 1362 in the other, and **nothing else in 3120 frames**.
`test/sweep-test.js` holds the synthetic contract tests, including that fast
linear motion, scene cuts, slow fades and incoherent excursions all stay unflagged.

Because dropouts are rare, the sweep is cheap: capture and encode still overlap,
and a second encode pass happens only if a frame was actually repaired.

```
--sweep-max-run <n>   longest dropout to look for (default 4 frames)
--no-sweep            skip the check entirely
```

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
- `--reap` deletes each frame once it has been encoded, if disk is tight. It now
  runs *after* the dropout sweep rather than during the encode, because the
  sweep has to read the frames back.

### 5. Two videos fighting over one frame folder

**What it looks like.** You render video A, then video B from the same project.
B reports its frames as "already on disk", encodes in seconds, and turns out to
be a copy of A. Or you pass `--fresh` and B deletes A's frames. Or you run both
at once and each one ends up with a mixture of the two. None of it announces
itself: the frames are all the right *size*, so the size-conflict guard stays
quiet, and the video looks plausible until you watch it.

**Cause.** Frames were filed under `<project>/frames/<W>x<H>@<fps>` — keyed by
output format and nothing else. A Claude Code zip routinely holds several
compositions, and they all resolved to the same folder. The same collision hit
the output file, because every bundle in such a zip is called `index.html`.

**Fix.** A frame folder is now keyed by *which composition it belongs to* as
well as what shape it is, and the output name comes from the bundle's path
rather than its file name:

```
project/
  frames/
    myzip_intro-fc2cc7/1920x1080@24/     <- intro/index.html
    myzip_outro-a135cf/1920x1080@24/     <- outro/index.html
  myzip_intro_1920x1080_24fps.mp4
  myzip_outro_1920x1080_24fps.mp4
```

Identity is the entry's path *inside* the project, not a hash of its contents.
That is deliberate: hashing would give every edit of the bundle a brand-new
folder and silently orphan the frames you already paid for. The content hash
goes into `settings.json` instead, so a changed bundle produces a warning you
can act on rather than a surprise.

While a render is using a folder it holds a heartbeated lock file there. A
second render that wants the same folder is **refused with the name of the
process holding it**, instead of quietly joining in:

```
  Another render is already using this frame folder.
    .../frames/myzip_intro-fc2cc7/1920x1080@24
    held by pid 10309 on my-laptop (1920x1080@24), last seen 1s ago
```

Two *different* compositions render side by side perfectly happily — that is the
whole point. A lock left behind by a killed process goes stale after 90 s and is
reclaimed automatically, so a crash never leaves a folder unusable.

**Your existing frames are safe.** Frames in the old layout are *moved* into the
new per-composition folder on the first run and reused, so nothing is
re-rendered. If the project holds more than one composition there is no way to
know whose frames those are, so they are left exactly where they are and the
tool says so.

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

```bash
node render.js --input project.zip --list-entries
```

```
   1) intro/index.html    8s · 2 scene(s): Open, Rise
   2) body/index.html    32s · 4 scene(s): Silos, Unify, OnePane, IPAM
   3) outro/index.html    5s · 1 scene(s): Close
```

**Or queue them and walk away.** A 4K export is long enough that "come back in
ten minutes, then answer three questions, then come back again" is the whole
cost of a multi-video project:

```bash
node render.js --input project.zip --all              # every composition
node render.js --input project.zip --queue 1,3        # just these two
node render.js --input project.zip --queue 2-4        # a range
node render.js --input project.zip --queue "intro,outro"
```

The queue **never stops on a failure** — one composition that will not render is
not a reason to abandon the other three. Each item gets its own frame folder,
its own lock and its own output file, and the summary at the end says which
succeeded and which did not:

```
  Queue finished  18s total
    ok   intro/index.html    9s  myzip_intro_1920x1080_24fps.mp4
    ok   outro/index.html    9s  myzip_outro_1920x1080_24fps.mp4

  All 2 rendered.
```

Re-running the queue retries only what is left: finished frames are reused, so
it picks up where it stopped. The interactive menu has the same thing as option
`9) Queue several videos`, which appears when the project holds more than one.

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

# Render every video in a zip, unattended
node render.js --input project.zip --all --res 4k --fps 30 -y

# Just two of them
node render.js --input project.zip --queue "intro,outro"

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
it back on. If a blink is longer than four frames, raise `--sweep-max-run`. If it
persists, `--jobs 1` reduces compositor pressure.

**"I rendered a second video and got the first one again."** Fixed — frame
folders are now per-composition (section 5 above). If you are on an older copy,
delete `frames/` and re-render.

**"Another render is already using this frame folder."** Exactly what it says:
another process holds that composition/resolution. Wait for it, or render a
different one — two different compositions run side by side fine. If you are
certain nothing else is running, the lock goes stale after 90 s and the next
attempt reclaims it.

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
| `lib/workspace.js` | Per-composition frame folders and render locks |
| `lib/queue.js` | Rendering several compositions back to back |
| `lib/scenes.js` | Reads the composition's scene list; resolves `--scene` |
| `lib/sweep.js` | Paint-dropout detection and repair |
| `lib/pixels.js` | Glow measurement |
| `lib/doctor.js` | The diagnostic suite |
| `test/selftest.js` | End-to-end checks against deliberately broken fixtures |
| `test/sweep-test.js` | Dropout-detector contract (specificity) |
| `test/workspace-test.js` | Frame-folder isolation, locking, queue selection |

```bash
npm test            # all three suites
npm run selftest    # just the browser-backed end-to-end checks
```

Fixtures: `test/fixture` (a deliberately wall-clock-driven bundle),
`test/fixture-clipped` (a glow clipped to a rectangle on purpose),
`test/fixture-multi` (two compositions both called `index.html`), and
`test/fixture-blink` (drops a panel for three frames on purpose, so the sweep's
detect → re-render → *reproduces identically, keep the original* path is
exercised end to end).

### Why the input is served over HTTP

Projects are served from a short-lived local HTTP server rather than opened with
`file://`. `file://` blocks ES module imports, `fetch()` and some font loads under
Chromium's origin rules, so a multi-file project that works when you double-click
it can still half-load under `file://` — and a half-loaded project renders as
missing text or missing panels.
