// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

import { determinismScript, NO_TRANSITIONS_CSS } from './determinism.js';
import { launchBrowser } from './browser.js';
import { ADAPTERS, OM_STAGE_SELECTOR, toUrl } from './probe.js';
import { readPngSizeBuf } from './frames.js';
import { c, sha1, even, clamp, progressBar, writeProgress, clearLine, isTTY, fmtDuration, summariseRanges } from './util.js';

// Extra viewport height handed to the stage so WIDTH is always the dimension
// that decides its scale. The bundle computes
//   scale = min(clientW/authoredW, (clientH - barH)/authoredH)
// with barH an internal constant. Making the height term comfortably larger
// forces min() to pick the width term, which we control exactly -- so this keeps
// working whatever barH happens to be in a given starter version.
const VIEWPORT_SLACK = 260;

const MAX_FRAME_RETRIES = 3;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
//
// There are two ways to render a 1920x1080 composition at 4K:
//
//   'dpr' (default)
//     Viewport stays at the AUTHORED css size and deviceScaleFactor is raised.
//     The stage lays out at scale 1.0 and Chromium rasterises the whole page at
//     the higher device density -- blur radii, radial gradients, shadows and
//     text all computed at output resolution, exactly as on a retina display.
//
//   'layout'
//     Viewport is set to 3840 css px and the stage scales ITSELF up with a CSS
//     transform. Chromium rasterises the layer at its own raster scale and then
//     scales the result.
//
// dpr is the default because it is the more faithful of the two: the stage never
// scales, so nothing depends on how Chromium picks a raster scale for a
// transformed layer, and supersampling composes cleanly on top of it.
//
// A caveat worth recording, because it is easy to assume otherwise: switching to
// dpr was NOT observed to change how blurred glows render. On a real 3840x2160
// Claude Design bundle both modes produced pixel-comparable glows at 1080p,
// 1440p, 4K native and 4K supersampled. If a glow renders as a rectangle on your
// machine, this setting is unlikely to be the cause -- run the doctor, which
// compares graphics backends (see browser.js) rather than layout strategies.
//
// Note also that a composition authored at 4K exporting at 4K has scale 1.0 in
// BOTH modes, so the two are identical in that very common case.
export function computeGeometry(project, opts = {}) {
  const ss = Math.max(1, Math.min(4, opts.ss || 1));
  const scaleMode = opts.scaleMode || 'dpr';

  const outH = even(opts.targetHeight || project.height);
  const outW = even(project.width * (outH / project.height));

  if (scaleMode === 'layout') {
    return {
      scaleMode, ss, outW, outH,
      stageCssW: outW, stageCssH: outH,
      viewportW: outW, viewportH: outH + VIEWPORT_SLACK,
      dsf: ss,
      captureW: outW * ss, captureH: outH * ss,
    };
  }

  // dpr: never scale the stage, scale the device instead.
  const dsf = +((outH / project.height) * ss).toFixed(6);
  return {
    scaleMode, ss, outW, outH,
    stageCssW: project.width, stageCssH: project.height,
    viewportW: Math.round(project.width), viewportH: Math.round(project.height) + VIEWPORT_SLACK,
    dsf,
    captureW: Math.round(project.width * dsf), captureH: Math.round(project.height * dsf),
  };
}

// ---------------------------------------------------------------------------
// Worker setup
// ---------------------------------------------------------------------------

/** Injected CSS: hide export chrome and (in absolute mode) neutralise transitions. */
function hardeningCss(timeMode) {
  let css = `
[data-export-hide], [data-om-export-hide] { display: none !important; }
html, body { margin: 0 !important; padding: 0 !important; background: transparent; }
`;
  // A CSS transition runs on its own clock from the moment it is triggered, which
  // is meaningless when scrubbing. In 'replay' mode determinism.js drives them
  // properly instead, so only 'absolute' needs them flattened.
  if (timeMode === 'absolute') css += NO_TRANSITIONS_CSS;
  return css;
}

export async function prepareWorker(browser, cfg, id) {
  const ctx = await browser.newContext({
    viewport: { width: cfg.geom.viewportW, height: cfg.geom.viewportH },
    deviceScaleFactor: cfg.geom.dsf,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',   // never let the comp think motion is disabled
    forcedColors: 'none',
  });

  const [detFn, detCfg] = determinismScript({
    mode: cfg.timeMode,
    freezeTimers: cfg.freezeTimers,
    seed: cfg.seed,
  });
  await ctx.addInitScript(detFn, detCfg);

  const page = await ctx.newPage();
  page.setDefaultTimeout(cfg.timeout);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(toUrl(cfg.input), { waitUntil: 'load', timeout: cfg.timeout });

  // Wait for the adapter's own readiness signal (fonts inlined, Stage mounted).
  const readySrc = ADAPTERS[cfg.adapter].ready.toString();
  // polling MUST be an interval, not the default 'raf'. determinism.js replaces
  // requestAnimationFrame with a queue that only drains when we drain it, so a
  // raf-polled wait never runs its predicate and silently burns the full timeout
  // on every worker.
  await page.waitForFunction(
    ({ sel, src }) => (new Function('return ' + src))()(sel),
    { sel: OM_STAGE_SELECTOR, src: readySrc },
    { timeout: 90000, polling: 250 },
  ).catch(() => { /* non-fatal: continue and let the size check catch trouble */ });

  // Style is added AFTER readiness, not before, and this ordering is load-bearing.
  // A Claude Design bundle is self-extracting: it unpacks its resources and then
  // runs document.documentElement.replaceWith(...), which destroys the entire
  // original DOM -- including any <style> injected at load time. Adding the
  // hardening CSS before that point means it silently disappears a second later
  // and export chrome ends up baked into the frames.
  await page.addStyleTag({ content: hardeningCss(cfg.timeMode) }).catch(() => {});

  // Fonts and images must be fully resolved, or text reflows between frames.
  await page.evaluate(async () => {
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}
    await Promise.all(Array.from(document.images).map((img) =>
      img.complete
        ? (img.decode ? img.decode().catch(() => {}) : null)
        : new Promise((r) => { img.onload = img.onerror = r; })));
  });

  const w = { id, ctx, page, pageErrors, virtualT: -1, clip: null, stats: null, stableState: null };
  await renderAt(w, cfg, 0);
  await page.waitForTimeout(cfg.warmMs);

  // Measure the stage so the clip is exact, then verify it is the size we asked
  // for. A mismatch here means the frames would be resampled, which is the
  // difference between "sharp" and "nearly sharp".
  const rect = await page.evaluate((sel) => {
    const el = document.querySelector(sel) || document.body;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, OM_STAGE_SELECTOR);

  const wantW = cfg.geom.stageCssW, wantH = cfg.geom.stageCssH;
  w.stageRect = rect;
  w.scaleOff = Math.abs(rect.w - wantW) > 1.5 || Math.abs(rect.h - wantH) > 1.5;
  w.clip = {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: wantW,
    height: wantH,
  };

  // One throwaway capture. The very first composite of a freshly built layer
  // tree can differ from every subsequent one by a subpixel or two on
  // antialiased edges -- raster warm-up, not drift. Paying for one discarded
  // frame here makes frame 0 byte-identical to a re-render of frame 0, which is
  // what the resume and verification logic relies on.
  try { await shoot(w, cfg); } catch { /* the retry path will surface real faults */ }

  return w;
}

// ---------------------------------------------------------------------------
// One frame
// ---------------------------------------------------------------------------
//
// The order below is load-bearing.
//   1. seek       -- tell the composition where it is; this mutates the DOM
//                    (elements mount, classes flip, new animations are created)
//   2. real tick  -- let React/the framework actually COMMIT that DOM change.
//                    Without this, step 3 pins animations that do not exist yet.
//   3. setTime    -- move the virtual clock, drain rAF, pin every CSS animation,
//                    transition and media element to exactly this instant
//   4. real tick  -- anything born during step 3 gets caught by a second sync
//   5. waitPaint  -- two REAL rAFs so the compositor finishes the frame before
//                    we serialise it
export async function renderAt(w, cfg, timeSec) {
  const seekSrc = ADAPTERS[cfg.adapter].seek.toString();
  await w.page.evaluate(async ({ sel, t, src }) => {
    const seek = (new Function('return ' + src))();
    const S = window.__CDV;
    const tick = () => new Promise((r) =>
      (S && S.realSetTimeout ? S.realSetTimeout(r, 0) : setTimeout(r, 0)));

    try { seek(sel, t); } catch (e) { /* adapter may be a no-op (clock mode) */ }
    await tick();

    if (S && !S.disabled) {
      S.setTime(t);
      await tick();
      S.syncAnimations();
      S.syncMedia();
      await S.waitPaint();
    } else {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))));
    }
  }, { sel: OM_STAGE_SELECTOR, t: timeSec, src: seekSrc });

  if (cfg.settleMs > 0) await w.page.waitForTimeout(cfg.settleMs);
  w.virtualT = timeSec;
}

/**
 * Step the virtual clock forward through the timeline without capturing, so
 * animations that are BORN mid-timeline (a card that mounts at t=4.2s and
 * transitions in) exist with the right birth time. Only used in 'replay' mode.
 * Runs entirely inside the page, so it costs one round trip, not one per step.
 */
async function warmTo(w, cfg, targetT) {
  if (cfg.timeMode !== 'replay') return;
  let from = w.virtualT;
  if (from < 0 || from > targetT) {
    await w.page.reload({ waitUntil: 'load', timeout: cfg.timeout });
    const readySrc2 = ADAPTERS[cfg.adapter].ready.toString();
    await w.page.waitForFunction(
      ({ sel, src }) => (new Function('return ' + src))()(sel),
      { sel: OM_STAGE_SELECTOR, src: readySrc2 }, { timeout: 90000, polling: 250 },
    ).catch(() => {});
    await w.page.addStyleTag({ content: hardeningCss(cfg.timeMode) }).catch(() => {});
    from = 0;
  }
  if (targetT <= from) return;
  const seekSrc = ADAPTERS[cfg.adapter].seek.toString();
  await w.page.evaluate(({ sel, from, to, stride, src }) => {
    const seek = (new Function('return ' + src))();
    const S = window.__CDV;
    for (let t = from; t < to; t += stride) {
      try { seek(sel, t); } catch {}
      if (S && !S.disabled) S.setTime(t);
    }
  }, { sel: OM_STAGE_SELECTOR, from, to: targetT, stride: cfg.warmStride, src: seekSrc });
  w.virtualT = targetT;
}

async function shoot(w, cfg) {
  return w.page.screenshot({
    clip: w.clip,
    type: 'png',
    caret: 'hide',
    // NOTE: animations must stay 'allow' (the default). Playwright's
    // animations:'disabled' looks like exactly what a frame renderer wants, but
    // it CANCELS infinite CSS animations and rewinds them to currentTime 0 for
    // the duration of the shot -- so every captured frame would show an ambient
    // loop frozen at its 0% keyframe, and it leaves the animation un-paused
    // afterwards, corrupting the next frame's state too. determinism.js already
    // pins every animation to the exact seek time, which is both correct and
    // strictly more precise. Verified by test/selftest.js.
    animations: 'allow',
    scale: 'device',          // honour deviceScaleFactor instead of downscaling to css px
    // Deliberately much shorter than the overall timeout. A screenshot that has
    // not returned in a minute is wedged, not slow, and the retry path replaces
    // the whole browser context -- which recovers. Leaving this at the global
    // 10-minute timeout turns one wedged frame into a ten-minute stall.
    timeout: Math.min(cfg.timeout, 60000),
  });
}

/**
 * Shoot until the picture stops changing.
 *
 * THE FIX FOR "A SECTION OF THE CARD IS MISSING", AT THE POINT IT HAPPENS.
 *
 * The dropout sweep repairs frames after the fact, which works but is a net
 * rather than a fix: it costs a re-render per suspect, it has to guess which
 * frames are suspect, and on hardware where the race fires often it saturates.
 * This catches the same fault at capture time, and the reason it can is a
 * property the rest of the pipeline already guarantees:
 *
 *   determinism.js pins every clock, so a CORRECTLY RASTERISED frame is
 *   byte-identical however many times you screenshot it.
 *
 * That is not an assumption -- test/selftest.js asserts it, and it was
 * re-confirmed against the real bundle behind this fix (five timestamps, three
 * captures each, all byte-identical). So if two consecutive captures of one
 * pinned instant DISAGREE, the difference cannot be animation and cannot be
 * noise: part of the layer tree had not finished rasterising when the first one
 * was serialised. Re-shooting gives the compositor another full round, and the
 * shot after that agrees. No false positives by construction.
 *
 * Cost is one extra screenshot per frame, which is why it is opt-in
 * (--stable-capture) rather than always on -- on hardware that does not have
 * this problem it is pure overhead. The repair path in sweep.js turns it on
 * regardless, since by then a frame is already known to be suspect.
 *
 * Exported separately from the browser so the loop itself can be unit-tested.
 *
 * @param shootFn  () => Promise<Buffer>
 * @param need     how many consecutive identical shots to require (2 = default)
 * @param tries    give up after this many shots and return the last one
 */
export async function shootStable(shootFn, { need = 2, tries = 4 } = {}) {
  let last = null, lastHash = null, agree = 1, shots = 0;
  for (;;) {
    const buf = await shootFn();
    shots++;
    const hash = sha1(buf);
    agree = (lastHash !== null && hash === lastHash) ? agree + 1 : 1;
    last = buf; lastHash = hash;
    if (agree >= need) return { buf, shots, stable: true };
    if (shots >= tries) return { buf: last, shots, stable: false };
  }
}

/**
 * How many consecutive identical shots this frame needs, in 'auto' mode.
 *
 * Whether a machine hands over half-drawn frames is a property of its GPU
 * driver and its load, not of the composition -- and the people it happens to
 * are exactly the people who do not know to reach for a flag. So the default
 * measures instead of asking: shoot the opening frames the careful way, and if
 * none of them needed a second look, drop to one shot for the rest.
 *
 * A clean machine pays for a couple of dozen extra screenshots out of a
 * thousand-frame render and then runs at full speed. An affected one gets full
 * protection without having been told to ask for it. Occasional re-probes cover
 * a machine that only starts dropping frames once it is hot or once a heavier
 * scene arrives.
 */
export const PROBE_FRAMES = 16;
// How often a frame still gets the careful treatment once probing decided this
// machine looked clean. This is NOT belt-and-braces -- it is the difference
// between catching a scene-specific race and missing it entirely.
//
// The opening probe only ever sees the opening scene. A composition whose tenth
// scene has a fragile layer tree (a filter over a huge 3D subtree, say) renders
// its first 16 frames perfectly, adaptive mode switches off, and the race 1500
// frames later is never sampled. Observed exactly that way on a real 64s reel:
// the fault sits at frame ~1587, and a 250-frame re-probe interval steps right
// over it. Spot-checking one frame in twenty costs ~5% of a screenshot budget
// and samples every scene, and one catch is enough -- the mode latches on.
export const SPOT_CHECK_EVERY = 20;
export const REPROBE_EVERY = SPOT_CHECK_EVERY;   // old name, same meaning

export function makeStableState(cfg) {
  const raw = cfg.stableCapture;
  if (raw === 'off' || raw === 0 || raw === 1) return { mode: 'off', need: 1, probed: 0, since: 0 };
  if (typeof raw === 'number' && raw >= 2) return { mode: 'on', need: raw, probed: 0, since: 0 };
  return { mode: 'probing', need: 2, probed: 0, since: 0 };   // 'auto' and the default
}

/** Decide, per frame, whether this one gets the careful treatment. */
export function stableNeedFor(st) {
  if (!st) return 1;
  if (st.mode === 'on') return st.need;
  if (st.mode === 'probing') return st.need;
  // off: keep sampling, so a scene that only misbehaves later is still found.
  return st.since >= SPOT_CHECK_EVERY ? st.need : 1;
}

/** Fold one frame's result back into the shared decision. */
export function stableObserve(st, { need, shots, stable }) {
  if (!st) return;
  const wasCareful = need >= 2;
  const found = wasCareful && (shots > need || !stable);
  if (found) { st.mode = 'on'; st.since = 0; return; }
  if (st.mode === 'probing') {
    st.probed++;
    if (st.probed >= PROBE_FRAMES) st.mode = 'off';
    return;
  }
  st.since = wasCareful ? 0 : st.since + 1;
}

export async function captureFrame(w, cfg, index, timeSec) {
  await warmTo(w, cfg, timeSec);
  await renderAt(w, cfg, timeSec);

  const st = w.stableState;
  const need = st ? stableNeedFor(st) : Math.max(1, cfg.stableCapture === 'auto' ? 1 : (cfg.stableCapture || 1));
  if (need < 2) { stableObserve(st, { need, shots: 1, stable: true }); return shoot(w, cfg); }

  const r = await shootStable(() => shoot(w, cfg), {
    need,
    tries: Math.max(need, cfg.stableTries || 4),
  });
  stableObserve(st, { need, shots: r.shots, stable: r.stable });
  // Surfaced by the caller: a frame that needed extra shots is one this machine
  // would otherwise have exported broken, and a frame that never settled is one
  // the sweep still has to look at.
  if (w.stats) {
    if (r.shots > need) w.stats.restabilised++;
    if (!r.stable) w.stats.unstable.push(index);
  }
  return r.buf;
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

/**
 * @param cfg   full render config
 * @param todo  [{ index, time }]
 * @param sink  DiskSink (or anything with write(i, buf))
 */
export async function runCapture(cfg, todo, sink, { label = 'Rendering', onFrame = null } = {}) {
  if (!todo.length) return { failed: [], captured: 0 };

  const jobs = Math.min(cfg.jobs, todo.length);
  // Every frame number PRINTED below is the one on disk (see DiskSink in
  // lib/frames.js) -- a scene render's frames are not numbered from 0, so a
  // failure has to say which real frame it is, not its position within this
  // one render, or "frame 12 failed" would be meaningless to look up.
  const off = cfg.frameOffset || 0;
  const { browser, info } = await launchBrowser({
    raster: cfg.raster, channel: cfg.channel, angle: cfg.angle,
    paintDeterminism: !!cfg.paintDeterminism,
  });

  console.log(`\n  ${c.b(label)} ${c.b(String(todo.length))} frame(s)`);
  console.log(c.dim(`  ${jobs} worker(s) · ${cfg.raster} raster · ${cfg.geom.captureW}x${cfg.geom.captureH} ` +
    `capture (${cfg.geom.scaleMode}, dpr ${cfg.geom.dsf}${cfg.geom.ss > 1 ? `, ss ${cfg.geom.ss}x` : ''}) ` +
    `· time=${cfg.timeMode}`));
  if (info.shellWarning) console.log(c.r(`  ! ${info.shellWarning}`));

  const workers = [];
  const started = Date.now();
  let done = 0, retries = 0, mismatches = 0, verified = 0;
  const failed = [];
  const warnings = new Set();
  // Shared across workers: how often the compositor handed us a half-drawn
  // frame. This is the number that tells someone whether their machine has the
  // paint-race problem at all, so it is worth reporting even when it is zero.
  const stats = { restabilised: 0, unstable: [] };
  // One decision shared by every worker: whether this machine needs the careful
  // capture path. Per-worker probing would pay the probe cost N times over and
  // could reach N different answers about one machine.
  const stableState = makeStableState(cfg);

  try {
    for (let i = 0; i < jobs; i++) {
      if (isTTY) process.stdout.write(c.dim(`  starting worker ${i + 1}/${jobs}...\r`));
      const w = await prepareWorker(browser, cfg, i);
      w.stats = stats;
      w.stableState = stableState;
      if (w.scaleOff) {
        warnings.add(`stage measured ${w.stageRect.w.toFixed(1)}x${w.stageRect.h.toFixed(1)} ` +
          `but ${cfg.geom.stageCssW}x${cfg.geom.stageCssH} was requested`);
      }
      workers.push(w);
    }
    clearLine();

    // In 'replay' mode a worker must walk the timeline in order, so hand out
    // contiguous chunks. In 'absolute' mode every frame is independent, so a
    // shared pull-queue gives better load balancing and loses at most one frame
    // if a worker dies.
    const queue = cfg.timeMode === 'replay'
      ? chunkQueue(todo, jobs, cfg.chunkFrames)
      : todo.map((t) => [t]);
    let cursor = 0;
    const nextBatch = () => (cursor < queue.length ? queue[cursor++] : null);

    const verifyEvery = cfg.verify ? 1 : 0;

    const tick = setInterval(() => {
      writeProgress(progressBar(done, todo.length, started,
        retries ? `  ${c.y(`retries ${retries}`)}` : ''), done, todo.length);
    }, isTTY ? 500 : 4000);

    const runWorker = async (slot) => {
      for (;;) {
        const batch = nextBatch();
        if (!batch) break;
        for (const { index, time } of batch) {
          let ok = false;
          for (let attempt = 1; attempt <= MAX_FRAME_RETRIES && !ok; attempt++) {
            try {
              let buf = await captureFrame(workers[slot], cfg, index, time);

              if (verifyEvery && index % verifyEvery === 0) {
                verified++;
                const again = await captureFrame(workers[slot], cfg, index, time);
                if (sha1(again) !== sha1(buf)) { mismatches++; buf = again; }
              }

              const dim = readPngSizeBuf(buf);
              if (dim && (dim.width !== cfg.geom.captureW || dim.height !== cfg.geom.captureH)) {
                throw new Error(`frame ${index + off} came out ${dim.width}x${dim.height}, ` +
                  `expected ${cfg.geom.captureW}x${cfg.geom.captureH}`);
              }

              sink.write(index, buf);
              if (onFrame) onFrame(index);
              done++; ok = true;
            } catch (err) {
              retries++;
              console.error('\n  ' + c.y(`[w${slot}] frame ${index + off} attempt ${attempt}/${MAX_FRAME_RETRIES}: ` +
                String(err.message).split('\n')[0]));
              // A wedged CDP session rarely recovers -- replace the whole context.
              try { await workers[slot].ctx.close(); } catch {}
              try {
                workers[slot] = await prepareWorker(browser, cfg, slot);
                workers[slot].stats = stats;
                workers[slot].stableState = stableState;
              } catch { await new Promise((r) => setTimeout(r, 2000)); }
            }
          }
          if (!ok) { failed.push(index); console.error('  ' + c.r(`gave up on frame ${index + off}`)); }
        }
      }
    };

    try {
      await Promise.all(workers.map((_, slot) => runWorker(slot)));
    } finally {
      clearInterval(tick);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  clearLine();
  const elapsed = (Date.now() - started) / 1000;
  console.log(`  ${c.g('Captured')} ${done}/${todo.length} in ${fmtDuration(elapsed)} ` +
    c.dim(`(${(done / Math.max(elapsed, 0.001)).toFixed(2)} fps${retries ? `, ${retries} retries` : ''})`));

  for (const wmsg of warnings) console.log(c.y(`  ! ${wmsg}`));

  if (stableState.mode !== 'off' || stats.restabilised) {
    if (stats.restabilised) {
      console.log(c.g(`  Stable capture caught ${stats.restabilised} half-drawn frame(s)`) +
        c.dim(' — each was re-shot until the picture stopped changing.'));
      console.log(c.dim('    Those would have exported with content missing.'));
    } else {
      console.log(c.dim('  Stable capture: every frame was complete on the first shot.'));
    }
    if (stats.unstable.length) {
      console.log(c.y(`  ! ${stats.unstable.length} frame(s) never settled: ` +
        `${summariseRanges(stats.unstable.map((i) => i + off)).slice(0, 200)}`));
      console.log(c.dim('    Raise --stable-tries, or let the dropout sweep take them.'));
    }
  } else if (stableState.probed >= PROBE_FRAMES) {
    console.log(c.dim(`  Stable capture: not needed — the first ${PROBE_FRAMES} frames all came ` +
      'back complete, so the rest were captured at full speed.'));
  }
  if (verified && mismatches / verified > 0.05) {
    console.log(c.y(`\n  ! ${mismatches}/${verified} verified frames differed on a second render.`));
    console.log(c.dim('    That is the compositing-dropout signature. The sweep (on by default)'));
    console.log(c.dim('    already repairs this; --raster software is steadier here too, but'));
    console.log(c.dim('    breaks 3D depth order (preserve-3d/translateZ) if this composition uses it.'));
  }
  if (failed.length) {
    console.log(c.r(`\n  ${failed.length} frame(s) failed: ` +
      `${summariseRanges(failed.map((i) => i + off)).slice(0, 300)}`));
    console.log(c.dim('    They are absent from disk, so re-running picks them straight up.'));
  }
  return { failed, captured: done };
}

function chunkQueue(todo, jobs, chunkFrames) {
  const size = Math.max(10, chunkFrames || Math.ceil(todo.length / (jobs * 4)));
  const out = [];
  for (let i = 0; i < todo.length; i += size) out.push(todo.slice(i, i + size));
  return out;
}
