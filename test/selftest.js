#!/usr/bin/env node
// End-to-end checks against test/fixture, which deliberately contains the same
// failure modes reported in the wild: a CSS @keyframes ambient loop, a
// requestAnimationFrame ticker reading performance.now(), a blurred radial glow,
// and a seek-driven main timeline.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../lib/input.js';
import { probeProject } from '../lib/probe.js';
import { launchBrowser } from '../lib/browser.js';
import { prepareWorker, captureFrame, computeGeometry } from '../lib/capture.js';
import { decodeToRgb, analyseGlow, frameDelta } from '../lib/pixels.js';
import { sha1, c } from '../lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? c.g('PASS') : c.r('FAIL')}  ${name}${detail ? c.dim('  — ' + detail) : ''}`);
};

async function shootSeries(project, url, over, times) {
  const geom = computeGeometry(project, {
    targetHeight: over.targetHeight || 720, ss: over.ss || 1, scaleMode: over.scaleMode || 'dpr',
  });
  const cfg = {
    input: url, project, adapter: project.adapter, geom,
    timeMode: over.timeMode || 'absolute', freezeTimers: !!over.freezeTimers,
    seed: 0x2f6e2b1, raster: over.raster || 'gpu', channel: null,
    settleMs: 0, warmMs: 200, warmStride: 1 / 15, timeout: 120000, fps: 30,
  };
  const { browser } = await launchBrowser({ raster: cfg.raster });
  try {
    const w = await prepareWorker(browser, cfg, 0);
    const out = [];
    for (const t of times) {
      out.push(await captureFrame(w, cfg, 0, t));
      if (over.stallMs) await new Promise((r) => setTimeout(r, over.stallMs));
    }
    return out;
  } finally { await browser.close().catch(() => {}); }
}

(async () => {
  const server = await startServer(path.join(__dirname, 'fixture'));
  const url = `${server.origin}/index.html?__render=1`;
  console.log(c.b('\n  Self-test — test/fixture\n'));

  const project = await probeProject(url, { raster: 'gpu' });
  check('bundle detected as animations-v3', project.adapter === 'om', `adapter=${project.adapter}`);
  check('size and duration read off the bundle',
    project.width === 1280 && project.height === 720 && project.duration === 4,
    `${project.width}x${project.height} ${project.duration}s`);
  check('full Chromium, not the headless shell', !project.browserInfo.isShell,
    project.browserInfo.label);

  const T = [1.0, 1.0333333, 1.0666667];

  // --- 1. determinism with the virtual clock ---------------------------------
  // Each capture is followed by a deliberate ~450ms real-time stall. A page on
  // the real clock drifts during that; a page on the virtual clock cannot.
  const a1 = await shootSeries(project, url, { timeMode: 'absolute', stallMs: 450 }, [1.0, 1.0, 1.0]);
  const sameAbs = sha1(a1[0]) === sha1(a1[1]) && sha1(a1[1]) === sha1(a1[2]);
  check('same timestamp is byte-identical with --time absolute', sameAbs,
    sameAbs ? 'no wall-clock drift' : `delta ${frameDelta(a1[0], a1[2])}`);

  // --- 2. the fixture really does have wall-clock motion ----------------------
  const a0 = await shootSeries(project, url, { timeMode: 'off', stallMs: 450 }, [1.0, 1.0, 1.0]);
  const differsOff = sha1(a0[0]) !== sha1(a0[2]);
  check('same timestamp DIFFERS with --time off (fixture is genuinely wall-clock driven)',
    differsOff, differsOff ? `mean pixel delta ${frameDelta(a0[0], a0[2])}` : 'no drift detected');

  // --- 3. parallel workers agree -------------------------------------------
  // The real-world failure this guards against: frames rendered by different
  // workers disagree, so the video flickers at the seams between their ranges.
  const [wA] = await shootSeries(project, url, { timeMode: 'absolute' }, [1.5]);
  const [wB] = await shootSeries(project, url, { timeMode: 'absolute' }, [1.5]);
  const agree = sha1(wA) === sha1(wB);
  check('two independent workers produce the same frame', agree,
    agree ? 'no seam flicker' : `mean pixel delta ${frameDelta(wA, wB)}`);

  // --- 4. ambient CSS animation actually advances ----------------------------
  // Regression guard. Playwright's screenshot animations:'disabled' cancels
  // infinite CSS animations and rewinds them to currentTime 0, which silently
  // freezes every ambient loop at its first keyframe. If that ever comes back,
  // these frames become identical.
  const amb = await shootSeries(project, url, { timeMode: 'absolute' },
    [0.0, 0.42, 0.85]);
  const ambMoves = sha1(amb[0]) !== sha1(amb[1]) && sha1(amb[1]) !== sha1(amb[2]);
  check('ambient CSS @keyframes animation advances between frames', ambMoves,
    ambMoves ? `deltas ${frameDelta(amb[0], amb[1])} / ${frameDelta(amb[1], amb[2])}`
             : 'frames identical — animations are being frozen');

  // --- 5. the CSS animation is pinned to the seek time, not the wall clock ----
  // Same seek time reached after different amounts of real elapsed time must
  // still land on the same keyframe.
  const pinnedA = await shootSeries(project, url, { timeMode: 'absolute' }, [2.0]);
  const pinnedB = await shootSeries(project, url, { timeMode: 'absolute', stallMs: 700 },
    [0.5, 1.0, 2.0]);
  const pinned = sha1(pinnedA[0]) === sha1(pinnedB[2]);
  check('t=2.0 renders identically regardless of the path taken to it', pinned,
    pinned ? 'animation phase follows the seek, not the clock'
           : `mean pixel delta ${frameDelta(pinnedA[0], pinnedB[2])}`);

  // --- 6. glow shape ----------------------------------------------------------
  for (const mode of ['dpr', 'layout']) {
    const [frame] = await shootSeries(project, url,
      { scaleMode: mode, targetHeight: 1080 }, [1.2]);
    const an = analyseGlow(decodeToRgb(frame, 900));
    const ok = an.ratio != null && an.ratio < 1.15;
    check(`glow renders radially in scale-mode=${mode}`, ok,
      `${an.verdict}${an.ratio != null ? ` (ratio ${an.ratio})` : ''}`);
  }

  await server.close();

  // --- 7. the glow measurement can actually detect a clipped glow --------------
  // Without this the "radial (correct)" verdicts above prove nothing: a metric
  // that always says "fine" would pass them too. This fixture holds two
  // identical glows, one of them inside overflow:hidden, which produces the same
  // rectangular clipping signature as the compositing bug.
  const clipServer = await startServer(path.join(__dirname, 'fixture-clipped'));
  const clipUrl = `${clipServer.origin}/index.html`;
  const clipProject = await probeProject(clipUrl, { raster: 'gpu' });
  const [clipFrame] = await shootSeries(clipProject, clipUrl, { targetHeight: 720 }, [0.5]);
  const clipAn = analyseGlow(decodeToRgb(clipFrame, 900));
  const detected = clipAn.ratio != null && clipAn.ratio > 1.25;
  check('a deliberately box-clipped glow IS detected as clipped', detected,
    `worst of ${clipAn.glowCount} glows: ratio ${clipAn.ratio} — ${clipAn.verdict}`);

  const cleanOne = (clipAn.candidates || []).find((x) => x.ratio != null && x.ratio < 1.12);
  check('the unclipped glow in the same frame still measures as radial', !!cleanOne,
    cleanOne ? `ratio ${cleanOne.ratio}` : 'no radial candidate found');

  await clipServer.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n  ${failed.length ? c.r(`${failed.length} failed`) : c.g('all passed')} ` +
    `(${results.length} checks)\n`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(c.r(e.stack || e.message)); process.exitCode = 1; });
