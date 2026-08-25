// ---------------------------------------------------------------------------
// Render pipeline
// ---------------------------------------------------------------------------
//
// Capture and encode run AT THE SAME TIME. A feeder walks the frame indices in
// order, waits for each one to land on disk, and pushes it straight into a
// long-lived ffmpeg on stdin. On a 4K/60 project that removes the whole encode
// pass from the wall clock: the mp4 is finished seconds after the last frame is
// captured, instead of minutes later.
//
// Frames are still written to disk on the way through, so an interrupted run
// still resumes. Nothing about the resume guarantee is traded for the speed.
//
// Which folder those frames go in, and who is allowed to write to it, is
// workspace.js's job -- see the note at the top of that file for why a frame
// folder is keyed by composition and not just by output size.

import fs from 'node:fs';
import path from 'node:path';
import { DiskSink, listFrameIndices } from './frames.js';
import { runCapture } from './capture.js';
import { createEncoder, describeEncode, ffmpegBin } from './encode.js';
import { sweepDropouts } from './sweep.js';
import { framesDir, acquireLock, describeHolder } from './workspace.js';
import { c, sleep, fmtBytes, fmtDuration, summariseRanges, progressBar, writeProgress, clearLine, isTTY } from './util.js';

export const framesDirFor = framesDir;

/** The pre-workspace layout, kept only so existing frames can be adopted. */
export function legacyFramesDir(cfg) {
  const tag = (cfg.sceneTag || '') + (cfg.geom.scaleMode === 'layout' ? '-layout' : '');
  return path.join(cfg.workDir, 'frames',
    `${cfg.geom.captureW}x${cfg.geom.captureH}@${cfg.fps}${tag}`);
}

/**
 * Frames rendered by an older build sit in a folder that is not keyed by which
 * composition they belong to. Throwing that work away on upgrade would be rude,
 * and silently ADOPTING it into a project it may not belong to would be worse.
 * So it is adopted only when the answer is unambiguous -- one composition in the
 * project, so the frames can only be its -- and otherwise left alone with a note.
 */
export function adoptLegacyFrames(cfg) {
  const from = legacyFramesDir(cfg);
  const to = framesDir(cfg);
  if (from === to || !fs.existsSync(from)) return null;
  if (!listFrameIndices(from).length) return null;
  if (listFrameIndices(to).length) {
    return { moved: false, from, why: 'this project already has frames of its own' };
  }
  if ((cfg.bundleCount || 1) > 1) {
    return { moved: false, from, why: `this project holds ${cfg.bundleCount} compositions, ` +
      'so there is no way to tell which one those frames are of' };
  }
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) fs.rmdirSync(to);          // empty dir the sink may have made
    fs.renameSync(from, to);
    return { moved: true, from, to };
  } catch (e) {
    return { moved: false, from, why: e.message };
  }
}

export function saveSettings(cfg, dir) {
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    project: cfg.projectId || null,
    entry: cfg.entryRel || null,
    entryHash: cfg.entryHash || null,
    capture: `${cfg.geom.captureW}x${cfg.geom.captureH}`,
    output: `${cfg.geom.outW}x${cfg.geom.outH}`,
    fps: cfg.fps, scaleMode: cfg.geom.scaleMode, dpr: cfg.geom.dsf, ss: cfg.geom.ss,
    timeMode: cfg.timeMode, raster: cfg.raster, adapter: cfg.adapter,
    scene: cfg.window ? cfg.window.names.join('+') : null,
    timeOffset: cfg.timeOffset || 0,
    authored: `${cfg.project.width}x${cfg.project.height}`,
    duration: cfg.project.duration, totalFrames: cfg.totalFrames,
    updated: new Date().toISOString(),
  }, null, 2));
}

/** The bundle changing under a folder full of frames is worth saying out loud. */
function warnIfSourceChanged(cfg, dir) {
  if (!cfg.entryHash) return;
  let prev;
  try { prev = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); } catch { return; }
  if (!prev.entryHash || prev.entryHash === cfg.entryHash) return;
  if (!listFrameIndices(dir).length) return;
  console.log(c.y('\n  The project file has changed since these frames were rendered.'));
  console.log(c.dim('  They are kept and reused as-is. If the change was meant to show up in'));
  console.log(c.dim('  the video, re-run with --fresh to redraw them.'));
}

/**
 * Render (or fill in) every frame and produce the video.
 * @param {object} cfg
 * @param {object} o
 * @param {boolean} o.encode      produce the video (false = frames only)
 * @param {boolean} o.concurrent  overlap encoding with capture
 * @param {boolean} o.reap        delete each frame once encoded
 * @param {boolean} o.sweep       scan for and repair paint dropouts
 */
export async function render(cfg, o = {}) {
  const encode = o.encode !== false;
  const concurrent = o.concurrent !== false;
  const reap = !!o.reap;
  const wantSweep = o.sweep !== false;

  const dir = framesDir(cfg);
  const adopted = adoptLegacyFrames(cfg);
  if (adopted && adopted.moved) {
    console.log(c.dim(`\n  Moved ${listFrameIndices(adopted.to).length} existing frame(s) into ` +
      `${path.relative(cfg.workDir, adopted.to)}`));
    console.log(c.dim('  (frame folders are now kept per composition, so two videos cannot collide)'));
  } else if (adopted) {
    console.log(c.dim(`\n  Note: ${path.relative(cfg.workDir, adopted.from)} holds frames from an ` +
      `older version. They are not being used — ${adopted.why}.`));
  }

  // Two renders sharing one frame folder corrupt each other's output in a way
  // that is invisible afterwards, so this is a hard stop rather than a warning.
  const lock = acquireLock(dir, {
    what: `${cfg.geom.outW}x${cfg.geom.outH}@${cfg.fps}${cfg.sceneTag || ''}`,
    project: cfg.projectId || null,
  });
  if (!lock.ok) {
    console.log(c.r('\n  Another render is already using this frame folder.'));
    console.log(c.dim(`    ${dir}`));
    console.log(c.dim(`    held by ${describeHolder(lock.holder)}`));
    console.log(c.dim('  Wait for it to finish, or render a different composition/resolution.'));
    return { ok: false, reason: 'locked', holder: lock.holder };
  }

  try {
    return await renderLocked(cfg, o, dir, { encode, concurrent, reap, wantSweep });
  } finally {
    lock.release();
  }
}

async function renderLocked(cfg, o, dir, { encode, concurrent, reap, wantSweep }) {
  const sink = new DiskSink(dir, cfg.geom.captureW, cfg.geom.captureH);

  const conflict = sink.sizeConflicts();
  if (conflict) {
    console.log(c.r('\n  This frame folder holds frames of more than one size:'));
    for (const [k, n] of conflict) console.log(`    ${k}: ${n}+ frames`);
    console.log(c.dim(`  They are from different runs. Delete ${dir} and start again.`));
    return { ok: false, reason: 'mixed-frame-sizes' };
  }

  warnIfSourceChanged(cfg, dir);
  if (cfg.fresh) {
    for (let i = 0; i < cfg.totalFrames; i++) sink.remove(i);
  }
  // --redo: frames the user can see are wrong. Dropping them here means the
  // normal "render what is missing" pass picks them up, so one flag re-renders
  // and re-encodes without anyone deleting PNGs by hand.
  if (cfg.redo && cfg.redo.length) {
    const hit = cfg.redo.filter((i) => i < cfg.totalFrames && sink.has(i));
    for (const i of hit) sink.remove(i);
    console.log(c.dim(`\n  Re-rendering ${hit.length} frame(s) on request: ` +
      `${summariseRanges(cfg.redo).slice(0, 120)}`));
  }
  saveSettings(cfg, dir);

  // Every index is checked individually, so a hole in the middle is found just
  // as reliably as a missing tail.
  const missing = sink.missing(cfg.totalFrames);
  const already = cfg.totalFrames - missing.length;
  if (already) {
    console.log(`\n  ${c.g(`${already}/${cfg.totalFrames}`)} frames already on disk` +
      (missing.length && missing.length <= 60
        ? c.dim(`  · to render: ${summariseRanges(missing)}`) : ''));
  }

  const t0off = cfg.timeOffset || 0;
  const todo = missing.map((i) => ({ index: i, time: t0off + i / cfg.fps }));

  if (!encode) {
    if (!todo.length) { console.log(c.g('  Nothing to render.')); return { ok: true }; }
    const r = await runCapture(cfg, todo, sink);
    if (!r.failed.length && wantSweep) await sweep(cfg, sink);
    return { ok: r.failed.length === 0, failed: r.failed };
  }

  if (!ffmpegBin()) {
    console.log(c.r('\n  No ffmpeg available. Run `npm install` to fetch the bundled build.'));
    return { ok: false, reason: 'no-ffmpeg' };
  }

  console.log(`\n${c.b('  Encoding plan')}`);
  console.log(describeEncode(cfg, cfg.geom.captureW, cfg.geom.captureH));

  // ---- everything already on disk: straight encode --------------------------
  if (!todo.length) {
    console.log(c.dim('\n  All frames present — encoding only.'));
    if (wantSweep) await sweep(cfg, sink);
    const res = await encodeAll(cfg, sink, { reap: false });
    if (res.ok) report(cfg, res);
    return res;
  }

  // ---- two-phase (capture, then encode) -------------------------------------
  if (!concurrent) {
    const r = await runCapture(cfg, todo, sink);
    if (r.failed.length) {
      console.log(c.y('\n  Stopping before export; your frames are preserved.'));
      return { ok: false, failed: r.failed };
    }
    if (wantSweep) await sweep(cfg, sink);
    const res = await encodeAll(cfg, sink, { reap });
    if (res.ok) report(cfg, res);
    return res;
  }

  // ---- concurrent ------------------------------------------------------------
  const encoder = createEncoder(cfg, {
    srcW: cfg.geom.captureW, srcH: cfg.geom.captureH, expectedFrames: cfg.totalFrames,
  });

  let captureFinished = false;
  let captureFailed = null;
  let feedError = null;

  const capturing = runCapture(cfg, todo, sink)
    .then((r) => { captureFinished = true; if (r.failed.length) captureFailed = r.failed; })
    .catch((e) => { captureFinished = true; captureFailed = []; feedError = e; });

  const feeding = (async () => {
    const t0 = Date.now();
    for (let i = 0; i < cfg.totalFrames; i++) {
      while (!sink.has(i)) {
        if (captureFailed) throw new Error(`capture failed before frame ${i}`);
        if (captureFinished && !sink.has(i)) throw new Error(`frame ${i} never arrived`);
        await sleep(40);
      }
      await encoder.push(sink.take(i));
      // Reaping is deferred until after the dropout sweep, which needs to read
      // the frames back. Doing it here would trade the blink fix for disk space.
      if (i % 25 === 0 && isTTY) {
        process.stdout.write(c.dim(`  encoding ${i + 1}/${cfg.totalFrames}` +
          `  (${fmtDuration((Date.now() - t0) / 1000)} elapsed)          \r`));
      }
    }
  })();

  try {
    await Promise.all([capturing, feeding]);
  } catch (e) {
    encoder.kill();
    await capturing.catch(() => {});
    console.log(c.r(`\n  ${feedError ? feedError.message : e.message}`));
    if (captureFailed && captureFailed.length) {
      console.log(c.dim(`  Missing: ${summariseRanges(captureFailed).slice(0, 200)}`));
      console.log(c.dim('  Re-run and choose "Fill gaps" — completed frames are kept.'));
    }
    return { ok: false, failed: captureFailed || [] };
  }

  clearLine();
  let res = await encoder.finish();

  // Capture and encode ran together, so the video already exists. Now scan for
  // paint dropouts. They are rare (a couple in a thousand frames), so the fast
  // path is: find nothing, keep the video we already made. Only if a frame was
  // actually repaired do we pay for a second encode pass.
  if (wantSweep) {
    const sw = await sweep(cfg, sink);
    if (sw && sw.repaired.length) {
      console.log(c.dim('  Re-encoding with the repaired frames...'));
      const again = await encodeAll(cfg, sink, { reap: false });
      if (again.ok) res = again;
    }
  }
  if (reap) for (let i = 0; i < cfg.totalFrames; i++) sink.remove(i);

  report(cfg, res);
  return { ok: true, ...res };
}

async function sweep(cfg, sink) {
  console.log('\n' + c.b('  Dropout check'));
  return sweepDropouts(cfg, sink, cfg.totalFrames, {
    maxRun: cfg.sweepMaxRun || 4,
    passes: cfg.sweepPasses || 2,
    sensitivity: cfg.sweepSensitivity || 'normal',
    outliers: cfg.sweepOutliers !== false,
  });
}

async function encodeAll(cfg, sink, { reap }) {
  const encoder = createEncoder(cfg, {
    srcW: cfg.geom.captureW, srcH: cfg.geom.captureH, expectedFrames: cfg.totalFrames,
  });
  const t0 = Date.now();
  try {
    for (let i = 0; i < cfg.totalFrames; i++) {
      if (!sink.has(i)) throw new Error(`frame ${i} is missing; use "Fill gaps" first.`);
      await encoder.push(sink.take(i));
      if (reap) sink.remove(i);
      if (i % 25 === 0) writeProgress(progressBar(i + 1, cfg.totalFrames, t0), i + 1, cfg.totalFrames);
    }
  } catch (e) {
    encoder.kill();
    console.log(c.r('\n  ' + e.message));
    return { ok: false };
  }
  clearLine();
  const res = await encoder.finish();
  return { ok: true, ...res };
}

function report(cfg, res) {
  console.log(`\n  ${c.g('Exported')} ${res.outFile}`);
  console.log(c.dim(`  ${fmtBytes(res.size)} · ${res.frames} frames · ` +
    `${cfg.geom.outW}x${cfg.geom.outH} @ ${cfg.fps} fps · ` +
    `${fmtDuration(res.frames / cfg.fps)}`));
}
