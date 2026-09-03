// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------
//
// Quality bugs in this pipeline are nearly impossible to reason about from a
// finished mp4, because half a dozen independent things can each produce
// "it looks wrong": the browser build, the way resolution is reached, the
// raster path, whether the page is using the real clock, the frame rate you
// picked, and the encoder. So rather than guess, the doctor renders the SAME
// timestamp under several configurations, measures what it can measure, and
// writes a side-by-side page you can actually look at.
//
// Four checks:
//   1. environment     -- ffmpeg, which Chromium build, GPU
//   2. glow / blur      -- same frame under 4 render configs, with an objective
//                          "is this radial or clipped to a box" measurement
//   3. capture stability -- does THIS machine hand over half-drawn frames?
//                          Measured first, because it is the noise floor every
//                          other comparison here has to be read against.
//   3b. determinism     -- render the same frame twice; identical or not
//   4. frame cadence    -- does the composition actually have new content at the
//                          frame rate you asked for, or are you duplicating

import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, ANGLE_BACKENDS } from './browser.js';
import { prepareWorker, captureFrame, computeGeometry } from './capture.js';
import { decodeToRgb, analyseGlow, frameDelta } from './pixels.js';
import { ffmpegBin } from './encode.js';
import { c, sha1, fmtBytes, isTTY, clearLine } from './util.js';

// Configurations to render the same frame under. The point is NOT to judge any
// one of them against an absolute threshold -- a rectangular panel legitimately
// has a rectangular halo, so "the glow measures 1.4" proves nothing on its own.
// The point is that these differ ONLY in how the page is rasterised. Identical
// content rendered through different graphics paths must look identical; where
// two of them disagree, one of them is wrong, and that disagreement is the bug.
const VARIANTS = [
  {
    id: 'A-recommended',
    title: 'Recommended (dpr + gpu + virtual clock)',
    why: 'What this tool uses by default.',
    over: { scaleMode: 'dpr', raster: 'gpu', timeMode: 'absolute', ss: 1, angle: null },
  },
  {
    id: 'B-legacy-layout',
    title: 'Legacy layout scaling',
    why: 'Stage scaled by a CSS transform instead of raising device pixel ratio — ' +
         'what most hand-rolled scripts do.',
    over: { scaleMode: 'layout', raster: 'gpu', timeMode: 'absolute', ss: 1, angle: null },
  },
  {
    id: 'C-software-raster',
    title: 'Software raster',
    why: 'No GPU compositing at all.',
    over: { scaleMode: 'dpr', raster: 'software', timeMode: 'absolute', ss: 1, angle: null },
  },
  {
    id: 'D-angle-swiftshader',
    title: 'ANGLE SwiftShader (no GPU driver)',
    why: "ANGLE's own CPU rasteriser. If this one renders a glow correctly and the " +
         'others do not, the fault is in the graphics driver, not the composition.',
    over: { scaleMode: 'dpr', raster: 'gpu', timeMode: 'absolute', ss: 1, angle: 'swiftshader' },
  },
  {
    id: 'E-supersampled',
    title: 'Supersampled 2x',
    why: 'Captures at double density and downsamples. Sharpest, ~4x slower.',
    over: { scaleMode: 'dpr', raster: 'gpu', timeMode: 'absolute', ss: 2, angle: null },
  },
];

function h(s) { return String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

export async function runDoctor(session, baseCfg) {
  const outDir = path.join(baseCfg.workDir, 'diagnosis');
  fs.mkdirSync(outDir, { recursive: true });

  console.log('\n' + c.b('  Diagnosis'));
  console.log(c.dim('  ' + '-'.repeat(60)));

  // ---- 1. environment -------------------------------------------------------
  const ff = ffmpegBin();
  const p = session.project;
  console.log(`  ffmpeg          ${ff ? c.g('found') : c.r('MISSING — run npm install')}`);
  console.log(`  browser         ${p.browserInfo.label}`);
  if (p.browserInfo.isShell) {
    console.log(c.r('    ! chrome-headless-shell detected.'));
    console.log(c.r('      This build mis-composites blur and backdrop-filter under transforms,'));
    console.log(c.r('      which turns radial glows into rectangles. Fix: npx playwright install chromium'));
  } else {
    console.log(c.dim('    full Chromium build — blur/backdrop-filter composite correctly'));
  }
  console.log(`  graphics        ${c.dim(String(p.gpu || 'unknown').slice(0, 56))}`);
  console.log(`  composition     ${p.width}x${p.height} · ${p.duration}s · ${p.adapterLabel}`);
  if (p.pageErrors && p.pageErrors.length) {
    console.log(c.y(`  page errors     ${p.pageErrors.length} (first: ${p.pageErrors[0].slice(0, 70)})`));
  }

  // Pick a timestamp with something on screen: a third of the way in.
  const probeT = Math.min(p.duration * 0.34, Math.max(0, p.duration - 0.05));

  // ---- 2. glow / blur comparison --------------------------------------------
  console.log('\n' + c.b('  Blur / glow rendering'));
  console.log(c.dim(`  Rendering t=${probeT.toFixed(2)}s under ${VARIANTS.length} configurations...`));

  const results = [];
  for (const v of VARIANTS) {
    const cfg = {
      ...baseCfg,
      raster: v.over.raster,
      timeMode: v.over.timeMode,
      // Forced on for every variant. These images exist to be DIFFERENCED
      // against each other, so a half-drawn capture in any one of them shows up
      // as "these two render paths disagree" -- a rasterisation fault that is
      // not there. Removing the compositor noise at the source is what makes
      // the comparison below mean what it says.
      stableCapture: 3, stableTries: 6,
      geom: computeGeometry(p, {
        targetHeight: baseCfg.geom.outH, ss: v.over.ss, scaleMode: v.over.scaleMode,
      }),
    };
    if (isTTY) process.stdout.write(c.dim(`    ${v.id} ...\r`));
    let buf = null, err = null;
    cfg.angle = v.over.angle;
    const { browser } = await launchBrowser({
      raster: cfg.raster, channel: cfg.channel, angle: v.over.angle,
    });
    try {
      const w = await prepareWorker(browser, cfg, 0);
      buf = await captureFrame(w, cfg, 0, probeT);
    } catch (e) { err = e.message; }
    finally { await browser.close().catch(() => {}); }

    const file = path.join(outDir, `${v.id}.png`);
    let glow = null;
    if (buf) {
      fs.writeFileSync(file, buf);
      try {
        glow = analyseGlow(decodeToRgb(buf, 900));
      } catch (e) { glow = { verdict: 'analysis failed: ' + e.message }; }
    }
    results.push({ ...v, file, cfg, glow, err, bytes: buf ? buf.length : 0 });
    clearLine();
    const label = v.id.padEnd(18);
    if (err) console.log(`    ${label} ${c.r('failed: ' + err.split('\n')[0].slice(0, 50))}`);
    else if (glow && glow.ratio != null) {
      const good = glow.ratio < 1.12;
      console.log(`    ${label} glow ${good ? c.g(glow.verdict) : c.y(glow.verdict)} ` +
        c.dim(`(diag/axis ${glow.ratio}` +
          `${glow.glowCount > 1 ? `, worst of ${glow.glowCount}` : ''})`));
    } else {
      console.log(`    ${label} ${c.dim(glow ? glow.verdict : 'no frame')}`);
    }
  }

  // ---- 2b. do the render paths agree with each other? -------------------------
  // This is the check that actually means something. Every variant rendered the
  // same instant of the same composition, so any visible difference between them
  // is a rasterisation fault rather than something the designer authored.
  //
  // Each was captured with stable capture forced on (see above), so a machine
  // with the paint race cannot manufacture a disagreement here that is really
  // just one of the two shots having been serialised early.
  const ok = results.filter((r) => !r.err && fs.existsSync(r.file));
  const disagreements = [];
  if (ok.length > 1) {
    console.log('\n' + c.b('  Do the render paths agree?'));
    const base = ok[0];
    for (const other of ok.slice(1)) {
      let delta = null;
      try {
        // Compare at a common size: variants differ in capture resolution by design.
        delta = frameDelta(fs.readFileSync(base.file), fs.readFileSync(other.file), 480);
      } catch { /* size mismatch or decode failure */ }
      const label = `${base.id} vs ${other.id}`.padEnd(34);
      if (delta == null) { console.log(`    ${label} ${c.dim('not comparable')}`); continue; }
      // Resampling between different capture densities leaves a small floor.
      const suspicious = delta > 2.0;
      if (suspicious) disagreements.push({ a: base.id, b: other.id, delta });
      console.log(`    ${label} mean pixel delta ${
        suspicious ? c.y(String(delta)) : c.g(String(delta))}`);
    }
    if (disagreements.length) {
      console.log(c.y('\n  ! These paths render the same frame differently.'));
      console.log(c.dim('    Open the images in the report and compare the soft edges. Whichever'));
      console.log(c.dim('    one looks right is the configuration to render with.'));
    } else {
      console.log(c.g('  All render paths agree — no rasterisation fault visible at this frame.'));
      console.log(c.dim('    If a glow still looks wrong to you, it is authored that way rather'));
      console.log(c.dim('    than introduced by the renderer. Try another timestamp with --at.'));
    }
  }

  // ---- 3. capture stability ---------------------------------------------------
  //
  // Determinism above asks whether the PAGE is reproducible. This asks whether
  // the COMPOSITOR is: given a page that is provably pinned, does this machine
  // still hand over frames with content missing? That is a property of the GPU
  // driver and the load, not of the composition, so it cannot be answered from
  // a finished video -- but it is the single most useful thing to know before
  // committing to a long render, because the fix (--stable-capture) is cheap
  // and the alternative (repairing dozens of frames afterwards, or dropping to
  // --software and losing 3D stacking) is not.
  console.log('\n' + c.b('  Capture stability'));
  console.log(c.dim('  Shooting one pinned frame repeatedly under parallel load. Every clock'));
  console.log(c.dim('  is frozen, so any two shots that differ mean the compositor handed'));
  console.log(c.dim('  over a half-drawn picture — the cause of missing panels and rows.'));

  const stability = await checkCaptureStability(session, baseCfg, probeT);
  if (stability.error) {
    console.log(c.y('  could not measure: ' + stability.error));
  } else {
    console.log(`  identical shots   ${stability.stable}/${stability.shots} ` +
      c.dim(`across ${stability.workers} parallel worker(s)`));
    if (stability.unstable > 0) {
      console.log(c.r(`\n  ! ${stability.unstable} of ${stability.shots} shots came back different.`));
      console.log(c.y('    This machine DOES hand over half-drawn frames. Every one of those'));
      console.log(c.y('    would have exported with content missing.'));
      console.log(c.dim(`    Fix:  --stable-capture        (re-shoots until the picture settles)`));
      console.log(c.dim(`    Also: --jobs ${Math.max(1, Math.floor((baseCfg.jobs || 2) / 2))} reduces the load that causes it.`));
      console.log(c.dim('    Avoid --software for this: it is steadier, but it breaks 3D'));
      console.log(c.dim('    depth sorting. Try --cpu-raster if you need both.'));
    } else {
      console.log(c.g('  Every shot identical — this machine composites cleanly at this load.'));
      console.log(c.dim('    If frames still come out missing content, raise --jobs to reproduce'));
      console.log(c.dim('    the load you actually render at, then re-run the doctor.'));
    }
  }

  // ---- 3b. determinism --------------------------------------------------------
  console.log('\n' + c.b('  Determinism'));
  console.log(c.dim('  Rendering the same timestamp twice. Identical bytes means every'));
  console.log(c.dim('  element is a pure function of the seek time — no wall-clock motion.'));

  const detModes = ['absolute', 'off'];
  const detOut = {};
  for (const mode of detModes) {
    // stableCapture is forced ON here, and that is the whole point of this
    // measurement. Without it, a machine whose compositor hands over half-drawn
    // frames looks exactly like a composition full of wall-clock motion, and
    // this check confidently gives the wrong advice -- observed on a real AMD
    // laptop, where it reported "something is not reachable from the virtual
    // clock" for a composition that renders byte-identically three times in a
    // row on hardware without the paint race. Shooting until the picture
    // settles removes the compositor from the measurement, so what is left is
    // genuinely the PAGE being non-deterministic.
    const cfg = { ...baseCfg, timeMode: mode, raster: 'gpu', stableCapture: 3, stableTries: 6,
      geom: computeGeometry(p, { targetHeight: baseCfg.geom.outH, ss: 1, scaleMode: 'dpr' }) };
    const { browser } = await launchBrowser({ raster: cfg.raster, channel: cfg.channel });
    try {
      const w = await prepareWorker(browser, cfg, 0);
      const a = await captureFrame(w, cfg, 0, probeT);
      // A real pause between the two captures: wall-clock motion needs time to
      // drift, otherwise a fast machine can accidentally look deterministic.
      await new Promise((r) => setTimeout(r, 900));
      const b = await captureFrame(w, cfg, 0, probeT);
      const same = sha1(a) === sha1(b);
      const delta = same ? 0 : frameDelta(a, b);
      detOut[mode] = { same, delta };
      const tag = `  time=${mode}`.padEnd(18);
      if (same) console.log(`${tag} ${c.g('identical')}  ${c.dim('deterministic')}`);
      else console.log(`${tag} ${c.y('DIFFERENT')}  ${c.dim(`mean pixel delta ${delta}`)}`);
      if (mode === 'absolute') fs.writeFileSync(path.join(outDir, 'determinism-absolute.png'), a);
    } catch (e) {
      detOut[mode] = { error: e.message };
      console.log(`  time=${mode}`.padEnd(18) + c.r(' failed: ' + e.message.split('\n')[0].slice(0, 50)));
    } finally { await browser.close().catch(() => {}); }
  }

  if (detOut.absolute && detOut.absolute.same === false) {
    // Two very different faults produce "the same timestamp rendered twice
    // differently", and they need opposite fixes, so say which one this is
    // rather than guessing. The stability check above already separated them:
    // it is the same question asked with the page held still.
    const raceOnly = stability && !stability.error && stability.unstable > 0;
    if (raceOnly) {
      console.log(c.y('\n  ! Frames differ even with the virtual clock on — but the capture'));
      console.log(c.y('    stability check above shows this machine hands over half-drawn'));
      console.log(c.y('    frames, which is enough on its own to explain it.'));
      console.log(c.dim('    Treat this as the paint race, not wall-clock motion:'));
      console.log(c.dim('      --stable-capture     re-shoot until the picture settles'));
      console.log(c.dim('    Do NOT reach for --freeze-timers or --time replay for this; they'));
      console.log(c.dim('    address a different fault and will not help.'));
    } else {
      console.log(c.y('\n  ! Frames still differ with the virtual clock on, and captures were'));
      console.log(c.y('    otherwise stable — so this is the composition, not the compositor.'));
      console.log(c.y('    Something in it is not reachable from the virtual clock: a'));
      console.log(c.y('    canvas/WebGL loop, a worker, or a video element.'));
      console.log(c.dim('    Try --freeze-timers, then --time replay.'));
    }
  } else if (detOut.off && detOut.off.same === false) {
    console.log(c.g('\n  Good: the virtual clock is what makes this composition reproducible.'));
    console.log(c.dim('    With --time off the same timestamp renders differently every time,'));
    console.log(c.dim('    which is exactly the stutter you see in an exported video.'));
  }

  // ---- 4. frame cadence -------------------------------------------------------
  console.log('\n' + c.b('  Frame cadence'));
  console.log(c.dim(`  Checking whether this composition has new content at ${baseCfg.fps} fps.`));
  const cadence = await checkCadence(session, baseCfg, probeT);
  if (cadence.error) {
    console.log(c.y('  could not measure: ' + cadence.error));
  } else {
    const pct = Math.round(cadence.dupRatio * 100);
    console.log(`  duplicate frames  ${pct}% of ${cadence.samples} consecutive frames`);
    if (cadence.dupRatio > 0.35) {
      const suggest = Math.max(1, Math.round(baseCfg.fps * (1 - cadence.dupRatio)));
      console.log(c.y(`  ! A third or more of your frames are byte-identical to the one before.`));
      console.log(c.y(`    This composition appears to update at roughly ${suggest} fps internally.`));
      console.log(c.y(`    Rendering it at ${baseCfg.fps} duplicates frames, which reads as judder.`));
      console.log(c.dim(`    Try --fps ${suggest} (or a whole multiple of it).`));
    } else {
      console.log(c.g(`  Fine — the composition genuinely moves at ${baseCfg.fps} fps.`));
    }
  }

  // ---- report ------------------------------------------------------------------
  const reportPath = path.join(outDir, 'report.html');
  fs.writeFileSync(reportPath,
    buildReport(session, baseCfg, results, detOut, cadence, probeT, disagreements));

  console.log('\n' + c.b('  Written'));
  console.log(`  ${reportPath}`);
  console.log(c.dim('  Open it and compare the four images at 100% zoom. Whichever renders'));
  console.log(c.dim('  your glows and text correctly is the configuration to use — the page'));
  console.log(c.dim('  lists the exact flags for each.\n'));

  return { outDir, reportPath, results, detOut, cadence };
}

/** Hash a run of consecutive frames and count how many repeat. */
/**
 * Does this machine hand over half-drawn frames?
 *
 * Deliberately runs SEVERAL workers at once even though it only measures one
 * of them: the fault is load-dependent, and a single idle worker composites
 * cleanly on hardware that drops content badly under a real render. Measuring
 * the quiet case would report "fine" to exactly the people who need the fix.
 */
async function checkCaptureStability(session, baseCfg, probeT, shots = 6) {
  const workers = Math.max(2, Math.min(baseCfg.jobs || 2, 4));
  const cfg = {
    ...baseCfg, timeMode: 'absolute', raster: 'gpu', stableCapture: 1,
    geom: computeGeometry(session.project, {
      targetHeight: baseCfg.geom.outH, ss: 1, scaleMode: 'dpr',
    }),
  };
  let browser;
  try {
    ({ browser } = await launchBrowser({ raster: cfg.raster, channel: cfg.channel, angle: cfg.angle }));
    const pool = [];
    for (let i = 0; i < workers; i++) pool.push(await prepareWorker(browser, cfg, i));

    // Keep the other workers busy on nearby timestamps while worker 0 is
    // measured, so the measurement happens under contention rather than idle.
    let busy = true;
    const churn = pool.slice(1).map(async (w, i) => {
      let k = 0;
      while (busy) {
        try { await captureFrame(w, cfg, 0, probeT + ((k++ % 5) + i + 1) / (cfg.fps || 30)); }
        catch { break; }
      }
    });

    const hashes = [];
    try {
      for (let i = 0; i < shots; i++) hashes.push(sha1(await captureFrame(pool[0], cfg, 0, probeT)));
    } finally {
      busy = false;
      await Promise.allSettled(churn);
    }

    const first = hashes[0];
    const stable = hashes.filter((h) => h === first).length;
    return { shots: hashes.length, stable, unstable: hashes.length - stable, workers };
  } catch (e) {
    return { error: e.message.split('\n')[0] };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function checkCadence(session, baseCfg, startT) {
  const p = session.project;
  const samples = Math.min(24, Math.max(6, Math.round(baseCfg.fps / 2)));
  const cfg = {
    ...baseCfg, raster: 'gpu', timeMode: 'absolute',
    // Small frames: we only care whether content CHANGED, not how it looks.
    geom: computeGeometry(p, { targetHeight: Math.min(360, p.height), ss: 1, scaleMode: 'dpr' }),
  };
  const { browser } = await launchBrowser({ raster: cfg.raster, channel: cfg.channel });
  try {
    const w = await prepareWorker(browser, cfg, 0);
    const hashes = [];
    for (let i = 0; i < samples; i++) {
      const t = Math.min(p.duration - 1e-4, startT + i / baseCfg.fps);
      hashes.push(sha1(await captureFrame(w, cfg, 0, t)));
    }
    let dup = 0;
    for (let i = 1; i < hashes.length; i++) if (hashes[i] === hashes[i - 1]) dup++;
    return { samples, dup, dupRatio: dup / (hashes.length - 1) };
  } catch (e) {
    return { error: e.message.split('\n')[0] };
  } finally { await browser.close().catch(() => {}); }
}

function buildReport(session, cfg, results, det, cadence, probeT, disagreements = []) {
  const cards = results.map((r) => {
    const g = r.glow || {};
    const flags = [
      `--scale-mode ${r.over.scaleMode}`,
      `--raster ${r.over.raster}`,
      `--time ${r.over.timeMode}`,
      r.over.ss > 1 ? `--ss ${r.over.ss}` : null,
      r.over.angle ? `--angle ${r.over.angle}` : null,
    ].filter(Boolean).join(' ');
    return `
    <section class="card">
      <h3>${h(r.title)}</h3>
      <p class="why">${h(r.why)}</p>
      ${r.err ? `<p class="bad">Failed: ${h(r.err)}</p>` : `<a href="${h(path.basename(r.file))}" target="_blank">
        <img src="${h(path.basename(r.file))}" alt="${h(r.title)}"></a>`}
      <dl>
        <dt>glow shape</dt><dd class="dim">${g.ratio != null
          ? `diagonal/axis ${g.ratio}${g.glowCount > 1 ? ` (worst of ${g.glowCount})` : ''}`
          : h(g.verdict || 'not measured')}</dd>
        <dt>capture</dt><dd class="dim">${r.cfg.geom.captureW}x${r.cfg.geom.captureH} @ dpr ${r.cfg.geom.dsf}</dd>
        <dt>flags</dt><dd><code>${h(flags)}</code></dd>
      </dl>
    </section>`;
  }).join('\n');

  const detRows = Object.entries(det).map(([mode, d]) => `
      <tr><td><code>--time ${h(mode)}</code></td>
      <td class="${d.same ? 'good' : 'warn'}">${d.error ? h(d.error) : d.same ? 'identical' : `different (mean delta ${d.delta})`}</td></tr>`).join('');

  return `<!doctype html><meta charset="utf-8"><title>Render diagnosis</title>
<style>
 :root{color-scheme:dark light}
 body{margin:0;padding:32px;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;
      background:#0d1017;color:#e6ebf5;max-width:1200px;margin-inline:auto}
 h1{font-size:24px;margin:0 0 4px} h2{font-size:18px;margin:36px 0 12px;
    border-bottom:1px solid #232a38;padding-bottom:6px}
 h3{font-size:16px;margin:0 0 4px}
 .meta{color:#93a1bd;font-size:13px;margin-bottom:8px}
 .grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(330px,1fr))}
 .card{background:#141926;border:1px solid #232a38;border-radius:12px;padding:16px}
 .card img{width:100%;border-radius:8px;background:#000;display:block;margin:10px 0;
    border:1px solid #232a38}
 .why{color:#93a1bd;font-size:13px;margin:0 0 6px}
 dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px;margin:8px 0 0}
 dt{color:#7f8da8} dd{margin:0}
 code{background:#1c2333;padding:2px 6px;border-radius:5px;font-size:12px}
 .good{color:#5fd39b} .warn{color:#ffcc66} .bad{color:#ff7a85} .dim{color:#7f8da8}
 table{border-collapse:collapse;font-size:14px} td{padding:5px 16px 5px 0}
 .tip{background:#141926;border-left:3px solid #4f8cff;padding:12px 16px;border-radius:0 8px 8px 0;margin:12px 0}
</style>
<h1>Render diagnosis</h1>
<p class="meta">${h(session.name)} — ${h(path.basename(session.entryFile))} ·
 ${cfg.project.width}x${cfg.project.height} · ${cfg.project.duration}s ·
 sampled at t=${probeT.toFixed(2)}s · ${h(cfg.project.adapterLabel)}</p>
<p class="meta">Browser: ${h(cfg.project.browserInfo.label)}${
  cfg.project.browserInfo.isShell ? ' <span class="bad">(headless shell — see below)</span>' : ''} ·
 GPU: ${h(String(cfg.project.gpu || 'unknown').slice(0, 60))}</p>

${cfg.project.browserInfo.isShell ? `<div class="tip"><strong class="bad">chrome-headless-shell detected.</strong>
 This cut-down Chromium build mis-composites <code>filter: blur()</code> and
 <code>backdrop-filter</code> when they sit under a transform, clipping them to the
 element's rectangular bounds. That is the classic "my radial glow exported as a square".
 Fix it with <code>npx playwright install chromium</code> and re-run this diagnosis.</div>` : ''}

<h2>Blur / glow rendering</h2>
<p class="meta">The same frame, same instant, under render paths that differ only in how the page
is rasterised. <strong>Compare the images, not the numbers.</strong> The diagonal/axis figure is
reported for reference, but on its own it proves nothing: a rectangular panel legitimately has a
rectangular halo, so a high number can be entirely correct. What is <em>not</em> correct is two of
these images disagreeing — identical content through different graphics paths should look identical.</p>
<div class="grid">${cards}</div>

<h2>Do the render paths agree?</h2>
${disagreements.length
  ? `<div class="tip"><strong class="warn">${disagreements.length} pair(s) disagree.</strong>
     <p>${disagreements.map((d) => `<code>${h(d.a)}</code> vs <code>${h(d.b)}</code> — mean pixel delta ${d.delta}`).join('<br>')}</p>
     <p>Identical content rendered through different graphics paths came out different, so one of
     them is wrong. Open both images above at full size and compare the soft edges of the glows.
     Whichever looks right names the configuration to render with.</p>
     <p>If <code>D-angle-swiftshader</code> is the one that looks right, the fault is in your GPU
     driver rather than in the composition or this renderer — render with
     <code>--angle swiftshader</code>. It is slower, but it does not involve the driver at all.</p>
     </div>`
  : `<div class="tip"><strong class="good">All render paths agree.</strong>
     <p>No rasterisation fault is visible at this timestamp. If a glow still looks wrong to you, it
     is most likely authored that way rather than introduced by the renderer — or the problem shows
     at a different moment in the timeline, in which case re-run this at another timestamp.</p></div>`}

<h2>Determinism</h2>
<p class="meta">The same timestamp rendered twice, ~1s apart. Anything driven by the wall clock
rather than the seek time will differ — and differing frames are what stutter looks like once
they are played back at a constant frame rate.</p>
<table>${detRows}</table>

<h2>Frame cadence</h2>
<p class="meta">${cadence.error ? h('Could not measure: ' + cadence.error)
  : `${Math.round(cadence.dupRatio * 100)}% of ${cadence.samples} consecutive frames were byte-identical to their predecessor at ${cfg.fps} fps.`}</p>
${!cadence.error && cadence.dupRatio > 0.35 ? `<div class="tip"><strong class="warn">Duplicated frames.</strong>
 This composition updates more slowly than the frame rate you asked for, so the export repeats
 frames. On playback that reads as judder even though nothing is technically wrong. Render at a
 rate the composition actually hits.</div>` : ''}

<h2>What to do next</h2>
<div class="tip">
 <p>Pick the card above whose image looks right, and pass its flags to the renderer. For example:</p>
 <p><code>node render.js --input &lt;your project&gt; --res 4k --fps ${cfg.fps} --scale-mode dpr --time absolute</code></p>
</div>
`;
}
