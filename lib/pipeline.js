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

import fs from 'node:fs';
import path from 'node:path';
import { DiskSink } from './frames.js';
import { runCapture } from './capture.js';
import { createEncoder, describeEncode, ffmpegBin } from './encode.js';
import { sweepDropouts } from './sweep.js';
import { c, sleep, fmtBytes, fmtDuration, summariseRanges, progressBar, writeProgress, clearLine, isTTY } from './util.js';

export function framesDirFor(cfg) {
  // The scene tag is part of the key: frames for "just the IPAM scene" start at
  // index 0 but represent t=32s onward, so they must never be mistaken for the
  // opening frames of a full render sitting in the same folder.
  const tag = (cfg.sceneTag || '') + (cfg.geom.scaleMode === 'layout' ? '-layout' : '');
  return path.join(cfg.workDir, 'frames',
    `${cfg.geom.captureW}x${cfg.geom.captureH}@${cfg.fps}${tag}`);
}

export function saveSettings(cfg, dir) {
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    capture: `${cfg.geom.captureW}x${cfg.geom.captureH}`,
    output: `${cfg.geom.outW}x${cfg.geom.outH}`,
    fps: cfg.fps, scaleMode: cfg.geom.scaleMode, dpr: cfg.geom.dsf, ss: cfg.geom.ss,
    timeMode: cfg.timeMode, raster: cfg.raster, adapter: cfg.adapter,
    authored: `${cfg.project.width}x${cfg.project.height}`,
    duration: cfg.project.duration, totalFrames: cfg.totalFrames,
    updated: new Date().toISOString(),
  }, null, 2));
}

/**
 * Render (or fill in) every frame and produce the video.
 * @param {object} cfg
 * @param {object} o
 * @param {boolean} o.encode      produce the video (false = frames only)
 * @param {boolean} o.concurrent  overlap encoding with capture
 * @param {boolean} o.reap        delete each frame once encoded
 */
export async function render(cfg, o = {}) {
  const encode = o.encode !== false;
  const concurrent = o.concurrent !== false;
  const reap = !!o.reap;

  const dir = framesDirFor(cfg);
  const sink = new DiskSink(dir, cfg.geom.captureW, cfg.geom.captureH);

  const conflict = sink.sizeConflicts();
  if (conflict) {
    console.log(c.r('\n  This frame folder holds frames of more than one size:'));
    for (const [k, n] of conflict) console.log(`    ${k}: ${n}+ frames`);
    console.log(c.dim(`  They are from different runs. Delete ${dir} and start again.`));
    return { ok: false, reason: 'mixed-frame-sizes' };
  }

  if (cfg.fresh) {
    for (let i = 0; i < cfg.totalFrames; i++) sink.remove(i);
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
    return encodeAll(cfg, sink, { reap: false });
  }

  // ---- two-phase (capture, then encode) -------------------------------------
  if (!concurrent) {
    const r = await runCapture(cfg, todo, sink);
    if (r.failed.length) {
      console.log(c.y('\n  Stopping before export; your frames are preserved.'));
      return { ok: false, failed: r.failed };
    }
    if (o.sweep !== false) {
      console.log('\n' + c.b('  Dropout check'));
      await sweepDropouts(cfg, sink, cfg.totalFrames);
    }
    return encodeAll(cfg, sink, { reap });
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
      if (reap) sink.remove(i);
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
  // one-frame paint dropouts. They are rare (a couple in a thousand frames), so
  // the fast path is: find nothing, keep the video we already made. Only if a
  // frame was actually repaired do we pay for a second encode pass.
  if (o.sweep !== false) {
    console.log('\n' + c.b('  Dropout check'));
    const sw = await sweepDropouts(cfg, sink, cfg.totalFrames);
    if (sw.repaired.length) {
      console.log(c.dim('  Re-encoding with the repaired frames...'));
      const again = await encodeAll(cfg, sink, { reap: false });
      if (again.ok) res = again;
    }
  }

  report(cfg, res);
  return { ok: true, ...res };
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
  let res = await encoder.finish();

  // Capture and encode ran together, so the video already exists. Now scan for
  // one-frame paint dropouts. They are rare (a couple in a thousand frames), so
  // the fast path is: find nothing, keep the video we already made. Only if a
  // frame was actually repaired do we pay for a second encode pass.
  if (o.sweep !== false) {
    console.log('\n' + c.b('  Dropout check'));
    const sw = await sweepDropouts(cfg, sink, cfg.totalFrames);
    if (sw.repaired.length) {
      console.log(c.dim('  Re-encoding with the repaired frames...'));
      const again = await encodeAll(cfg, sink, { reap: false });
      if (again.ok) res = again;
    }
  }

  report(cfg, res);
  return { ok: true, ...res };
}

function report(cfg, res) {
  console.log(`\n  ${c.g('Exported')} ${res.outFile}`);
  console.log(c.dim(`  ${fmtBytes(res.size)} · ${res.frames} frames · ` +
    `${cfg.geom.outW}x${cfg.geom.outH} @ ${cfg.fps} fps · ` +
    `${fmtDuration(res.frames / cfg.fps)}`));
}
