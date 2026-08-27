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

**A second detector, because one signature is not enough.** The run test asks
whether the frames *bracketing* a run agree with each other. During a hold that
is exactly right and beautifully specific. During a **transition it can never
fire**: in a cross-fade the frame before and the frame after a dropout are at
different points in the fade, so they never agree, and a panel that vanishes
mid-fade sails straight through. That is a structural blind spot, not a
threshold that needs nudging — `test/sweep-test.js` asserts the miss explicitly.

So there is a second test for exactly that case. For smooth change of any kind,
frame *i* sits close to the straight line between *i-1* and *i+1*:

```
residual(i) = mean | frame[i] - (frame[i-1] + frame[i+1]) / 2 |
```

Compare that against how non-linear this stretch of timeline normally is — the
*median* residual of nearby frames, excluding *i* and its immediate neighbours
so a dropout cannot raise its own baseline. Smooth motion, however fast, scores
near its own baseline. A frame that lost content spikes far above it.

**Re-rendering is the arbiter, not the detector.** The second test is
deliberately looser, and that is a design choice: a candidate costs one
re-render, and authored content reproduces identically and is put back. So the
detector only has to be a cheap filter, and the verification decides. On real
footage it flags about 1% of frames, nearly all of them authored fast cuts,
which are then correctly rejected. A repair is accepted when the frame **stops
being an outlier** — the same measure for both detectors, so neither can talk
the sweep into keeping a change that did not help.

**Validated against real footage.** Across two 1560-frame 4K exports of the same
project the run test finds the two-frame dropout at 1357–1358 in one, the
single-frame dropouts at 1167 and 1362 in the other, and **nothing else in 3120
frames**. `test/sweep-test.js` holds the synthetic contract tests: fast linear
motion, scene cuts, slow fades, hard-cut edges and incoherent excursions all
stay unflagged, and the fade-dropout case is covered end to end.

Because dropouts are rare, the sweep is cheap: capture and encode still overlap,
and a second encode pass happens only if a frame was actually repaired.

```
--sweep-max-run <n>              longest dropout to look for (default 4 frames)
--sweep-sensitivity low|normal|high
                                 how eagerly to suspect a frame during a
                                 transition. Try "high" if a blink survives a
                                 normal sweep; each extra candidate costs one
                                 re-render and authored content is kept
--no-transition-sweep            holds only; skip the transition pass
--no-sweep                       skip the check entirely
```

**When you can see it and the sweep cannot.** Detectors are heuristics and will
occasionally miss something you spot instantly. `--redo` re-renders exactly what
you name and re-encodes, without anyone deleting PNGs by hand:

```bash
node render.js --input index.html --redo 1440           # one frame
node render.js --input index.html --redo 1438-1442      # a range of frames
node render.js --input index.html --redo 48s            # by timestamp
node render.js --input index.html --redo 47.9s-48.1s    # a time range
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

### 6. Missing panels and rows on a fast machine (the paint race)

**What it looks like.** Panels, rows, or whole card bodies come out missing —
not blank frames, just *part* of the composition absent, with the layout
reflowed into the gap. It gets worse on faster machines with more parallelism,
not better, and `--software` reduces it at the cost of section 7 below.

**What it actually is, measured.** Taking a real 402-frame Energy scene that
exported with visible dropouts: 40 frames flagged, 9 more past the cap — about
12% of the scene. Frame 178 had the policy card sliced off mid-body, losing its
bottom edge and three of four rows.

Then the decisive test. Re-rendering that exact timestamp on its own, three
times at full 4K, produced **byte-identical and completely correct** frames
every time — as did the four timestamps around it. The frame is fine when
rendered calmly and breaks under full-render load. It is a raster race, not
authored content and not a bug in the composition.

**The fix: `--stable-capture`.** This rests on a property the pipeline already
guarantees. `determinism.js` pins every clock, so a *correctly rastered* frame
is byte-identical however many times you screenshot it — asserted in
`test/selftest.js` and re-confirmed above. Therefore:

> If two consecutive shots of one pinned instant disagree, the difference
> cannot be animation and cannot be noise. Part of the layer tree had not
> finished rasterising when the first one was serialised.

So the renderer shoots each frame until two consecutive shots are identical.
There are **no false positives by construction**, and re-shooting gives the
compositor another full round, which is all it needed.

**This is on by default, and adaptive.** Whether a machine has this fault is a
property of its GPU driver and its load — and the people it happens to are
exactly the people who would not know to reach for a flag. So the default
measures instead of asking: the opening 16 frames are captured the careful way,
and if none of them needed a second look, the rest run at full speed (with a
cheap re-probe every 250 frames, in case a machine only misbehaves once warm).

A clean machine pays for about 16 extra screenshots in a thousand-frame render.
An affected one is protected without having been told to ask.

```bash
node render.js --input project.zip                    # adaptive (default)
node render.js --input project.zip --stable-capture   # force on for every frame
node render.js --input project.zip --no-stable-capture  # never re-shoot
```

```
  Stable capture caught 23 half-drawn frame(s) — each was re-shot until the
  picture stopped changing.
    Those would have exported with missing content without --stable-capture.
```

Forced on, it costs about one extra screenshot per frame — still far cheaper
than repairing dozens of frames after the fact. The dropout sweep turns it on
for its own repairs regardless, since by then a frame is already known to be
suspect, and the doctor forces it on for every measurement it takes.

```
--stable-capture [n]     require n consecutive identical shots (default 2)
--no-stable-capture      trust the first picture every time
--stable-tries <n>       give up re-shooting after n attempts (default 4)
```

**Measured on a real affected machine** (Zenbook S16, AMD Radeon 890M), same
402-frame scene, before and after:

| | suspect frames |
|---|---|
| before | 40 flagged **+ 9 past the cap** (~12% of the scene) |
| after | **1** |

**It also fixes what the doctor tells you.** A machine with this fault and a
composition full of wall-clock motion produce the *same* symptom — "the same
timestamp rendered twice came out different" — and they need opposite fixes.
The doctor used to measure that with plain captures, so on an affected machine
it blamed the composition and recommended `--freeze-timers` / `--time replay`,
which do nothing for a paint race. Observed on a real report: a composition
that renders byte-identically three times in a row on unaffected hardware was
reported as "not reachable from the virtual clock".

Every measurement the doctor takes now forces stable capture on, so the
compositor is out of the picture and what is left is genuinely the page. The
verdict names which of the two faults it found, and says explicitly not to
reach for the other one's fix. The render-path comparison is captured the same
way, so a half-drawn shot can no longer manufacture a "these paths disagree"
that is really just the race.

**Find out whether you need it.** The doctor now answers this directly, by
shooting one pinned frame repeatedly *under parallel load* — the fault is
load-dependent, so an idle measurement would tell exactly the wrong people they
are fine:

```bash
node render.js --input project.zip --action doctor
```

```
  Capture stability
  identical shots   6/6 across 2 parallel worker(s)
  Every shot identical — this machine composites cleanly at this load.
```

If it reports shots coming back different, that machine does have the problem
and every one of those would have exported with content missing.

**Other levers**, in the order worth trying: `--jobs` lower (less contention
is less race), `--paint-determinism` (compositor flags that force paint to
finish — off by default because they can deadlock the screenshot call), and
`--cpu-raster` (section 7). Reach for `--software` last, for the reason below.

---

### 7. `--software` hides elements that should be in front

**What it looks like.** Switch to `--raster software` (or `--software`) — maybe
because of the paint-dropout problem above — and a panel that should sit in
front of another, per its own transform, renders *behind* it instead. Under
`--raster gpu` the same composition, same frame, is correct. This is not the
boxy-blur problem in section 3; the blur is fine, the *stacking* is wrong.

**Cause.** Confirmed by reading a real Claude Design composition's decompiled
source rather than guessing: scenes built as a 3D "camera" over a stack of
cards use `transform-style: preserve-3d` (25 occurrences in one real
composition) and `translateZ` to place each card at a real depth — one card's
own code comment explains why: *"Content under perspective() + preserve-3d
rasterises into a texture, so panel type softens however large the render is."*
Correct depth sorting for that — a card at `translateZ(40px)` drawing in front
of one at `translateZ(10px)` regardless of which is later in the DOM — is a GPU
compositor feature. `--raster software` passes `--disable-gpu
--disable-gpu-compositing`, and without a GPU compositor Chromium's software
path falls back to **paint order** (DOM order) instead of true 3D depth. A
card stack is exactly what breaks: this is expected Chromium behaviour with the
GPU compositor removed, not a bug in this renderer or in the composition.

**Fix.** Use `--raster gpu` (the default) for anything with a card stack, a
depth camera, or `preserve-3d` in general.

If a composition needs *both* — it drops frames under `gpu` **and** uses
`preserve-3d` — that is the exact trade section 6 removes. `--stable-capture`
fixes the dropouts while staying on `gpu`, so 3D stacking is never given up.
Reach for that first.

There is also a middle raster mode, because two separate things get called
"software" and conflating them is what forces the bad trade:

| | GPU fills the tiles | GPU assembles the layers | 3D depth sorting |
|---|---|---|---|
| `--raster gpu` (default) | yes | yes | correct |
| `--raster cpu-raster` | no | **yes** | **correct** |
| `--raster software` | no | no | **broken** |

`--disable-gpu-compositing` is the flag that loses depth sorting, and only
`software` passes it. `--cpu-raster` takes the tile-filling work off the GPU
driver while keeping the compositor, so it can be steadier than `gpu` without
reordering your cards. Being straight about the evidence: this is reasoned from
what each Chromium flag does, not measured, because this sandbox has no
discrete GPU — `gpu` is already SwiftShader in it, so the driver-specific fault
cannot be reproduced here. Try it against `--stable-capture` and keep whichever
is faster on your machine.

There is no code fix for this in the renderer: it is Chromium's own software
compositor behaviour, and disabling the GPU compositor is what `--software`
*is*. `--angle swiftshader` is not the same thing — it keeps the GPU compositor
enabled and only swaps which driver rasterises through it, so it does not lose
3D depth sorting and is the right tool for a driver-specific blur bug instead.

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

**Frame numbers match the FULL VIDEO, not the scene.** Rendering just IPAM
(32.0s-47.0s of a 30fps video) does not write `frame_000000.png` onward — it
writes `frame_000960.png` onward, exactly where those frames sit in a full
render's numbering:

```bash
node render.js --input project.zip --scene IPAM --res 4k --fps 30
```

```
  scenes    IPAM 32.0s – 47.0s  (frames 960-1409 of the full video)
```

That is what makes it possible to split a render across machines. Send one
scene to a second, faster device — maybe one without the raster bug your main
machine has — and its output drops straight into the same `frames/` folder as
the rest of the video with no renaming, because there is only one number for
"frame 1200" and both machines agree on it:

```bash
# on the fast machine
node render.js --input project.zip --scene IPAM --res 4k --fps 30 --action frames

# copy frames/<project>/3840x2160@30_IPAM/*.png into the same slot on the
# machine doing the full render, then finish it there
node render.js --input project.zip --res 4k --fps 30 --action fill
```

Every message that names a frame — "already on disk", a capture failure, a
dropout report, `--redo` — uses this same full-video numbering, so what you see
in the log is always the filename on disk.

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

**"Panels or rows come out missing."** Adaptive stable capture (section 6) is on
by default and should catch it. If a few still get through, force it on for
every frame with `--stable-capture`, and raise `--stable-tries` if the report
says frames "never settled". `--action doctor` confirms whether your machine
has the fault at all. Do not reach for `--software`: it is steadier but breaks
3D stacking (section 7).

**"The doctor says my composition is not reachable from the virtual clock."**
On a machine with the paint race that used to be a misdiagnosis — see section 6.
Update, then re-run the doctor: it now separates the two causes and will tell
you which one you actually have.

**"An element blinks for a moment."** That is the paint dropout described above,
and the sweep catches it automatically. If you disabled it with `--no-sweep`, turn
it back on. If a blink is longer than four frames, raise `--sweep-max-run`.

If one survives a normal sweep — most likely during a fade or a transition,
where a dropout is hardest to identify — escalate in this order:

```bash
node render.js --input index.html --sweep-sensitivity high   # suspect more
node render.js --input index.html --redo 47.9s-48.1s         # or just name it
```

`--redo` is the direct route: it re-renders those frames whatever the detectors
think, then re-encodes. `--jobs 1` also reduces compositor pressure, which makes
the underlying race less likely in the first place.

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

**"My machine hard-crashes or reboots during a long GPU render."** Stop rendering
on the GPU path and use `--cpu-raster` until it is resolved. This is worth
taking seriously and it is worth being precise about.

Observed on a real machine (Asus laptop, AMD Radeon 890M): repeated unclean
shutdowns during long 4K renders, and none on `--cpu-raster`. Three rounds of
evidence, escalating from log analysis to a live sensor capture during an
actual reproduction:

**Windows Event Log said nothing crashed.** Every unclean shutdown logged
`BugcheckCode: 0` — no stop code, no crash dump, no WHEA hardware error, no
long power-button press. A real BSOD records a bugcheck; this is a hard hang
or power-off Windows never got the chance to catch. The fault predated the
renderer (29 unclean shutdowns across eight months, every month), but the
render amplified it enormously — seven in one 52-minute session against a
baseline of about one a month. A full 8-month, 39,000-record unfiltered System
log turned up zero genuine GPU driver reset, TDR, or hardware-error events;
`LiveKernelReports\WATCHDOG` (where a recovered GPU hang would leave a dump)
was empty for the entire incident window.

**Live sensor logging (HWiNFO) during a reproduction confirmed why.** For the
full duration of a `--raster gpu` render, `CPU (Tctl/Tdie)` sat at 95-99.5°C —
pinned to AMD's ~100°C thermal ceiling essentially the whole time, not just
spiking. Hardware protection was engaging repeatedly: `Throttle Reason -
Thermal` fired on 64 of 340 samples, `Thermal Throttling (PROCHOT EXT)` on 41
of 340. The specific and telling detail: `PROCHOT CPU` (the CPU die's own
internal cutoff) **never fired, not once** — only `PROCHOT EXT`, which means an
*external* sensor (VRM or chassis/skin temperature, asserted via the embedded
controller) was hitting its limit before the CPU die itself did. That points at
this laptop's cooling/VRM thermal design under sustained combined CPU+GPU load,
not a CPU defect.

The honest conclusion: a user-space program should not be able to hard-kill a
machine, so the actual power-cut is still a platform, driver, or firmware
defect. But it is no longer a guess that heavy sustained GPU work is the
*trigger*: the machine spends the entire render within a degree or two of its
thermal safety limit, with the platform's own protection circuitry intervening
dozens of times. `--cpu-raster` avoids it because it keeps the GPU idle, so
combined package power never approaches that ceiling. This renderer cannot fix
a cooling/firmware limitation, and any change here claiming to would be
guessing.

What actually helps: use `--cpu-raster` for now (slower, but your work is
already protected — frames are checkpointed individually, so a machine that
dies mid-render loses nothing and re-running picks straight up); check for a
BIOS/EC firmware update (thermal/power management bugs on new silicon like this
are common in early revisions, and the external-vs-internal PROCHOT split
suggests the EC's thermal policy specifically, not just raw cooling capacity);
consider a cooling pad or a power-limit tool to cap sustained package power;
and stop the machine sleeping mid-render, since standby transitions correlate
with several of the historical crashes:

```
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

If you want to dig further yourself: log live sensors with HWiNFO
(`CPU (Tctl/Tdie)`, `GPU Temperature`, `Thermal Throttling (PROCHOT EXT/CPU)`,
`Throttle Reason - Thermal/Power`) during a `--raster gpu` render — that is
what actually identified the cause here, where retroactive Event Log analysis
alone could not. The WHEA-Logger channel is worth checking too, though on this
machine it was never part of a default System log export:

```powershell
Get-WinEvent -LogName 'Microsoft-Windows-WHEA-Logger/Operational' -MaxEvents 200
```

**"It runs out of disk."** Add `--reap`.

**"I rendered a scene before this fix and now it wants to re-render everything."**
Frame numbering for scene renders changed to match the full video (see
"Rendering part of a project" above) — a scene folder's frames used to start at
`frame_000000.png` and now start at wherever that scene sits in the full
timeline. Frames rendered under the old numbering are not recognised under the
new one, so the folder looks empty. This is a one-time cost per scene; delete
the old scene's frame folder or just let it re-render.

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
| `test/stable-test.js` | Stable capture: settles fast, gives up rather than spins |

```bash
npm test            # all four suites
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
