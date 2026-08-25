// ---------------------------------------------------------------------------
// Dropout sweep
// ---------------------------------------------------------------------------
//
// THE "A SECTION OF THE SCREEN BLINKS" FIX.
//
// The failure looks like this (confirmed by frame-differencing a real 4K/30
// export): for exactly one frame, part of the composition fails to paint. A row
// of the panel is missing, some numbers are blank, and a flat grey rectangle
// sits where the content should be. The frame before and the frame after are
// both correct and agree with each other. Played back, that reads as a UI
// element blinking.
//
// It is a partial-paint race: the frame was serialised before that subtree
// finished rasterising. Compositor flags reduce it (see browser.js) but do not
// eliminate it, so this is the safety net that actually guarantees the output.
//
// Detection is cheap and, importantly, SPECIFIC. A dropout has a signature that
// ordinary motion does not:
//
//     frame i differs a lot from i-1
//     frame i differs a lot from i+1
//     but i-1 and i+1 agree closely with each other
//
// i.e. the content went somewhere and came straight back. Under real motion,
// i-1 and i+1 are the FURTHEST apart of the three pairs, never the closest, so
// normal animation cannot trigger this. That is what makes it safe to run
// unattended -- unlike a file-size heuristic, which flags every legitimately
// dark transition frame and then loops forever re-rendering it.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ffmpegBin } from './encode.js';
import { runCapture } from './capture.js';
import { frameName } from './frames.js';
import { c, summariseRanges, fmtDuration } from './util.js';

/**
 * One ffmpeg pass over the whole frame sequence, producing a tiny grayscale
 * thumbnail per frame. 1500 4K frames reduce to a few megabytes, which makes
 * the comparison below essentially free.
 */
export function frameSignatures(dir, total, { width = 192 } = {}) {
  const bin = ffmpegBin();
  if (!bin) return null;
  const r = spawnSync(bin, [
    '-hide_banner', '-loglevel', 'error',
    '-start_number', '0',
    '-i', path.join(dir, 'frame_%06d.png'),
    '-frames:v', String(total),
    '-vf', `scale=${width}:-2,format=gray`,
    '-f', 'rawvideo', 'pipe:1',
  ], { maxBuffer: 1 << 30 });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) return null;

  const data = r.stdout;
  // Height is whatever the aspect produced; recover it from the byte count.
  const height = Math.round(data.length / (total * width));
  if (!(height > 0)) return null;
  return { data, width, height, frameBytes: width * height, count: Math.floor(data.length / (width * height)) };
}

const mad = (sig, i, j) => {
  const n = sig.frameBytes;
  const a = i * n, b = j * n;
  let s = 0;
  for (let k = 0; k < n; k++) s += Math.abs(sig.data[a + k] - sig.data[b + k]);
  return s / n;
};

/**
 * @param opts.minDelta   how different a frame must be from its neighbours
 *                        before it is considered at all (guards against noise)
 * @param opts.agreement  how closely the neighbours must agree, as a fraction
 *                        of the smaller neighbour distance. Lower = stricter.
 */
export function detectDropouts(sig, { minDelta = 1.0, agreement = 0.45 } = {}) {
  const out = [];
  for (let i = 1; i < sig.count - 1; i++) {
    const a = mad(sig, i, i - 1);
    if (a < minDelta) continue;
    const b = mad(sig, i + 1, i);
    if (b < minDelta) continue;
    const cc = mad(sig, i + 1, i - 1);
    if (cc < agreement * Math.min(a, b)) out.push({ index: i, prev: +a.toFixed(2), next: +b.toFixed(2), neigh: +cc.toFixed(2) });
  }
  return out;
}

/** Same measurement for a single candidate, used to judge a repair. */
function isolationScore(sig, i) {
  if (i <= 0 || i >= sig.count - 1) return Infinity;
  const a = mad(sig, i, i - 1), b = mad(sig, i + 1, i), cc = mad(sig, i + 1, i - 1);
  return cc / Math.max(1e-6, Math.min(a, b));
}

/**
 * Find dropouts, re-render them, and keep the re-render only if it is actually
 * better. A frame that reproduces the same way twice is authored content, not a
 * race, so it is left alone and reported -- never deleted, never looped on.
 */
export async function sweepDropouts(cfg, sink, total, opts = {}) {
  const dir = sink.dir;
  const t0 = Date.now();
  process.stdout.write(c.dim('  scanning frames for paint dropouts...\r'));

  const sig = frameSignatures(dir, total);
  if (!sig) {
    console.log(c.y('  Could not scan frames for dropouts (ffmpeg read failed); skipping.'));
    return { checked: 0, found: [], repaired: [], kept: [] };
  }

  const found = detectDropouts(sig, opts);
  process.stdout.write(' '.repeat(60) + '\r');

  if (!found.length) {
    console.log(`  ${c.g('No paint dropouts found')} ` +
      c.dim(`(${sig.count} frames scanned in ${fmtDuration((Date.now() - t0) / 1000)})`));
    return { checked: sig.count, found: [], repaired: [], kept: [] };
  }

  console.log(c.y(`  ${found.length} suspected dropout frame(s): ` +
    summariseRanges(found.map((f) => f.index)).slice(0, 200)));
  for (const f of found.slice(0, 6)) {
    console.log(c.dim(`    frame ${f.index} (t=${(f.index / cfg.fps).toFixed(2)}s) — ` +
      `differs from both neighbours (${f.prev}, ${f.next}) which agree (${f.neigh})`));
  }

  // Keep the originals so a repair can be rejected.
  const backup = new Map();
  for (const f of found) {
    try { backup.set(f.index, fs.readFileSync(sink.pathFor(f.index))); } catch {}
    sink.remove(f.index);
  }

  const t0off = cfg.timeOffset || 0;
  await runCapture(cfg, found.map((f) => ({ index: f.index, time: t0off + f.index / cfg.fps })),
    sink, { label: 'Re-rendering dropouts' });

  // Re-measure only the repaired frames, in place.
  const sig2 = frameSignatures(dir, total);
  const repaired = [], kept = [];
  for (const f of found) {
    if (!sink.has(f.index)) {                       // re-render failed outright
      const b = backup.get(f.index);
      if (b) sink.write(f.index, b);
      kept.push(f.index);
      continue;
    }
    const before = f.neigh / Math.max(1e-6, Math.min(f.prev, f.next));
    const after = sig2 ? isolationScore(sig2, f.index) : Infinity;
    if (sig2 && after > before * 1.5) {
      repaired.push(f.index);                       // now consistent with neighbours
    } else {
      // Reproduced the same way: this is authored content, not a race. Put the
      // original back so nothing is silently changed.
      const b = backup.get(f.index);
      if (b) sink.write(f.index, b);
      kept.push(f.index);
    }
  }

  if (repaired.length) {
    console.log(`  ${c.g(`Repaired ${repaired.length} frame(s)`)}: ${summariseRanges(repaired).slice(0, 160)}`);
  }
  if (kept.length) {
    console.log(c.dim(`  ${kept.length} frame(s) reproduced identically — authored content, left as-is: ` +
      `${summariseRanges(kept).slice(0, 160)}`));
  }
  return { checked: sig.count, found: found.map((f) => f.index), repaired, kept };
}
