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
// Geometry -- the other half of the "glow came out square" fix
// ---------------------------------------------------------------------------
//
// There are two ways to render a 1920x1080 composition at 4K, and they are NOT
// equivalent:
//
//   'dpr' (default, correct)
//     Viewport stays at the AUTHORED css size, and deviceScaleFactor is raised
//     to 2. The stage lays out at scale 1.0 and Chromium rasterises the entire
//     page at 2x device density. Blur radii, radial gradients, shadows and text
//     are all computed at full output resolution, exactly as they would be on a
//     retina display. This is what a real browser does on a 4K monitor.
//
//   'layout' (what most hand-rolled scripts do, and a common cause of bad glows)
//     Viewport is set to 3840 css px and the stage scales ITSELF up 2x with a
//     CSS transform. Chromium rasterises the layer at its own raster scale and
//     then scales the result. For a plain rectangle that is fine. For a
//     `filter: blur(140px)` glow sitting inside a preserve-3d subtree it is not:
//     the raster scale gets clamped, the blur is computed on a smaller surface
//     and then magnified, and a soft radial falloff degrades into visible steps
//     or a flat box. Same story for backdrop-filter and for large
//     radial-gradient backgrounds, which band badly when magnified.
//
// So 'dpr' is the default. 'layout' stays available because a few compositions
// are authored responsively and genuinely lay out better at the larger size.
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
  await page.addStyleTag({ content: hardeningCss(cfg.timeMode) });

  // Wait for the adapter's own readiness signal (fonts inlined, Stage mounted).
  const readySrc = ADAPTERS[cfg.adapter].ready.toString();
  await page.waitForFunction(
    ({ sel, src }) => (new Function('return ' + src))()(sel),
    { sel: OM_STAGE_SELECTOR, src: readySrc },
    { timeout: 90000 },
  ).catch(() => { /* non-fatal: continue and let the size check catch trouble */ });

  // Fonts and images must be fully resolved, or text reflows between frames.
  await page.evaluate(async () => {
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch {}
    await Promise.all(Array.from(document.images).map((img) =>
      img.complete
        ? (img.decode ? img.decode().catch(() => {}) : null)
        : new Promise((r) => { img.onload = img.onerror = r; })));
  });

  const w = { id, ctx, page, pageErrors, virtualT: -1, clip: null };
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
    await w.page.addStyleTag({ content: hardeningCss(cfg.timeMode) });
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
    timeout: cfg.timeout,
  });
}

export async function captureFrame(w, cfg, index, timeSec) {
  await warmTo(w, cfg, timeSec);
  await renderAt(w, cfg, timeSec);
  return shoot(w, cfg);
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
  const { browser, info } = await launchBrowser({ raster: cfg.raster, channel: cfg.channel });

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

  try {
    for (let i = 0; i < jobs; i++) {
      if (isTTY) process.stdout.write(c.dim(`  starting worker ${i + 1}/${jobs}...\r`));
      const w = await prepareWorker(browser, cfg, i);
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
                throw new Error(`frame ${index} came out ${dim.width}x${dim.height}, ` +
                  `expected ${cfg.geom.captureW}x${cfg.geom.captureH}`);
              }

              sink.write(index, buf);
              if (onFrame) onFrame(index);
              done++; ok = true;
            } catch (err) {
              retries++;
              console.error('\n  ' + c.y(`[w${slot}] frame ${index} attempt ${attempt}/${MAX_FRAME_RETRIES}: ` +
                String(err.message).split('\n')[0]));
              // A wedged CDP session rarely recovers -- replace the whole context.
              try { await workers[slot].ctx.close(); } catch {}
              try { workers[slot] = await prepareWorker(browser, cfg, slot); }
              catch { await new Promise((r) => setTimeout(r, 2000)); }
            }
          }
          if (!ok) { failed.push(index); console.error('  ' + c.r(`gave up on frame ${index}`)); }
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
  if (verified && mismatches / verified > 0.05) {
    console.log(c.y(`\n  ! ${mismatches}/${verified} verified frames differed on a second render.`));
    console.log(c.dim('    That is the compositing-dropout signature. Try --raster software.'));
  }
  if (failed.length) {
    console.log(c.r(`\n  ${failed.length} frame(s) failed: ${summariseRanges(failed).slice(0, 300)}`));
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
