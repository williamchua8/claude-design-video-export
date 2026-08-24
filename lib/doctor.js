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
//   3. determinism      -- render the same frame twice; identical or not
//   4. frame cadence    -- does the composition actually have new content at the
//                          frame rate you asked for, or are you duplicating

import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from './browser.js';
import { prepareWorker, captureFrame, computeGeometry } from './capture.js';
import { decodeToRgb, analyseGlow, frameDelta } from './pixels.js';
import { ffmpegBin } from './encode.js';
import { c, sha1, fmtBytes, isTTY, clearLine } from './util.js';

const VARIANTS = [
  {
    id: 'A-recommended',
    title: 'Recommended (dpr + gpu + virtual clock)',
    why: 'What this tool uses by default.',
    over: { scaleMode: 'dpr', raster: 'gpu', timeMode: 'absolute', ss: 1 },
  },
  {
    id: 'B-legacy-layout',
    title: 'Legacy layout scaling',
    why: 'Stage scaled by a CSS transform instead of raising device pixel ratio. ' +
         'This is what most hand-rolled scripts do, and the usual cause of boxy glows.',
    over: { scaleMode: 'layout', raster: 'gpu', timeMode: 'absolute', ss: 1 },
  },
  {
    id: 'C-software-raster',
    title: 'Software raster',
    why: 'No GPU compositing. Steadier on layer-heavy scenes, but approximates large blurs more crudely.',
    over: { scaleMode: 'dpr', raster: 'software', timeMode: 'absolute', ss: 1 },
  },
  {
    id: 'D-supersampled',
    title: 'Supersampled 2x',
    why: 'Captures at double density and downsamples. Sharpest, ~4x slower.',
    over: { scaleMode: 'dpr', raster: 'gpu', timeMode: 'absolute', ss: 2 },
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
      geom: computeGeometry(p, {
        targetHeight: baseCfg.geom.outH, ss: v.over.ss, scaleMode: v.over.scaleMode,
      }),
    };
    if (isTTY) process.stdout.write(c.dim(`    ${v.id} ...\r`));
    let buf = null, err = null;
    const { browser } = await launchBrowser({ raster: cfg.raster, channel: cfg.channel });
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

  // ---- 3. determinism --------------------------------------------------------
  console.log('\n' + c.b('  Determinism'));
  console.log(c.dim('  Rendering the same timestamp twice. Identical bytes means every'));
  console.log(c.dim('  element is a pure function of the seek time — no wall-clock motion.'));

  const detModes = ['absolute', 'off'];
  const detOut = {};
  for (const mode of detModes) {
    const cfg = { ...baseCfg, timeMode: mode, raster: 'gpu',
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
    console.log(c.y('\n  ! Frames still differ with the virtual clock on. Something in this'));
    console.log(c.y('    composition is not reachable from it — a canvas/WebGL loop, a worker,'));
    console.log(c.y('    or a video element. Try --freeze-timers, then --time replay.'));
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
  fs.writeFileSync(reportPath, buildReport(session, baseCfg, results, detOut, cadence, probeT));

  console.log('\n' + c.b('  Written'));
  console.log(`  ${reportPath}`);
  console.log(c.dim('  Open it and compare the four images at 100% zoom. Whichever renders'));
  console.log(c.dim('  your glows and text correctly is the configuration to use — the page'));
  console.log(c.dim('  lists the exact flags for each.\n'));

  return { outDir, reportPath, results, detOut, cadence };
}

/** Hash a run of consecutive frames and count how many repeat. */
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

function buildReport(session, cfg, results, det, cadence, probeT) {
  const cards = results.map((r) => {
    const g = r.glow || {};
    const ok = g.ratio != null && g.ratio < 1.12;
    const flags = [
      `--scale-mode ${r.over.scaleMode}`,
      `--raster ${r.over.raster}`,
      `--time ${r.over.timeMode}`,
      r.over.ss > 1 ? `--ss ${r.over.ss}` : null,
    ].filter(Boolean).join(' ');
    return `
    <section class="card">
      <h3>${h(r.title)}</h3>
      <p class="why">${h(r.why)}</p>
      ${r.err ? `<p class="bad">Failed: ${h(r.err)}</p>` : `<a href="${h(path.basename(r.file))}" target="_blank">
        <img src="${h(path.basename(r.file))}" alt="${h(r.title)}"></a>`}
      <dl>
        <dt>glow shape</dt><dd class="${ok ? 'good' : 'warn'}">${h(g.verdict || 'not measured')}${
          g.ratio != null ? ` <span class="dim">(diagonal/axis ${g.ratio}; 1.0 radial, 1.41 boxed${
            g.glowCount > 1 ? `; worst of ${g.glowCount} glows` : ''})</span>` : ''}</dd>
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
<p class="meta">The same frame under four render configurations. Open each at full size and
compare the soft edges. The measurement is the ratio between how far the glow reaches along
a diagonal versus along an axis: a true radial falloff is the same in every direction
(<strong>~1.0</strong>), while a glow clipped to its layer box reaches &radic;2 further into the
corners (<strong>~1.41</strong>).</p>
<div class="grid">${cards}</div>

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
