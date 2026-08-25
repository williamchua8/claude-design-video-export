// ---------------------------------------------------------------------------
// Dropout sweep
// ---------------------------------------------------------------------------
//
// THE "A SECTION OF THE SCREEN BLINKS" FIX.
//
// The failure, confirmed by frame-differencing real 4K/30 exports: for a very
// short moment part of the composition fails to paint. A panel is missing, the
// remaining content reflows into the space it left, and the frame after is
// correct again. Played back, that reads as the UI blinking.
//
// It is a partial-paint race -- the frame was serialised before that subtree
// finished rasterising. Compositor flags reduce it (see browser.js) but do not
// eliminate it, so this is the safety net that actually guarantees the output.
//
// RUNS, NOT SINGLE FRAMES. The first version of this only understood a dropout
// one frame long, and that turned out to be the common case rather than the
// only one. In a real 52s export the surviving artefact was TWO consecutive
// frames (1357-1358 at t=45.2s) that both lost the same panel:
//
//     1356  panel present
//     1357  panel gone          <-- mad(1357,1356) = 6.61
//     1358  panel gone          <-- mad(1358,1357) = 0.15   <<< the miss
//     1359  panel present       <-- mad(1359,1358) = 6.60
//
// The single-frame test asks whether frame i differs from BOTH neighbours. Here
// frame 1357's next neighbour is the second half of the same dropout, so they
// agree, and the test skips it; the same happens at 1358 looking backwards. The
// artefact is twice as visible as a one-frame blink and was invisible to the
// detector. So the signature is now stated over a RUN of 1..maxRun frames:
//
//     the frame entering the run differs a lot from the frame before it
//     the frame after the run differs a lot from the last frame of the run
//     the frames BRACKETING the run agree closely with each other
//     the frames INSIDE the run agree closely with each other
//
// i.e. the content went somewhere, stayed there briefly, and came straight
// back. Under real motion the bracketing frames are the FURTHEST apart of the
// set, never the closest, so ordinary animation cannot trigger this however
// fast it moves. That specificity is what makes it safe to run unattended --
// unlike a file-size heuristic, which flags every legitimately dark transition
// frame and then loops forever re-rendering it.
//
// Validation: across two real 3840x2160/30 exports of the same 1560-frame
// project this finds 1357-1358 in one and 1167 + 1362 in the other, and
// nothing else in either. Synthetic contract tests are in test/sweep-test.js.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ffmpegBin } from './encode.js';
import { runCapture } from './capture.js';
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
 * How isolated the run [start, start+len) is from the frames bracketing it.
 * ratio well below 1 is the dropout signature; ordinary motion sits above 1.
 */
export function runMetrics(sig, start, len) {
  const end = start + len - 1, after = end + 1;
  if (start < 1 || after >= sig.count) return null;
  const enter = mad(sig, start, start - 1);
  const exit = mad(sig, after, end);
  const bracket = mad(sig, after, start - 1);
  const floor = Math.min(enter, exit);
  let spread = 0;                              // how much the run varies internally
  for (let k = start + 1; k <= end; k++) spread = Math.max(spread, mad(sig, k, start));
  return { enter, exit, bracket, spread, floor, ratio: bracket / Math.max(1e-6, floor) };
}

/**
 * @param opts.minDelta   how different the run must be from what surrounds it
 *                        before it is considered at all (guards against noise)
 * @param opts.agreement  how closely the bracketing frames must agree, as a
 *                        fraction of the smaller boundary distance. Lower =
 *                        stricter.
 * @param opts.maxRun     longest dropout to look for, in frames
 * @param opts.coherence  how tightly the frames inside a run must match each
 *                        other, as a fraction of the boundary distance
 */
export function detectDropouts(sig, {
  minDelta = 1.0, agreement = 0.45, maxRun = 4, coherence = 0.5,
} = {}) {
  const out = [];
  for (let start = 1; start < sig.count - 1; start++) {
    for (let len = 1; len <= maxRun; len++) {
      if (start + len >= sig.count) break;
      const m = runMetrics(sig, start, len);
      if (!m) break;
      if (m.enter < minDelta || m.exit < minDelta) continue;
      // A longer run is likelier to be something the composition meant, so ask
      // for a correspondingly cleaner signature before believing it.
      const need = agreement * Math.pow(0.8, len - 1);
      if (m.bracket >= need * m.floor) continue;
      if (m.spread > coherence * m.floor) continue;

      const frames = [];
      for (let k = 0; k < len; k++) frames.push(start + k);
      out.push({
        start, len, frames,
        index: start,                          // len-1 alias, kept for callers/tests
        enter: +m.enter.toFixed(2), exit: +m.exit.toFixed(2),
        bracket: +m.bracket.toFixed(2), ratio: +m.ratio.toFixed(3),
        // legacy field names, so nothing that reads a hit breaks
        prev: +m.enter.toFixed(2), next: +m.exit.toFixed(2), neigh: +m.bracket.toFixed(2),
      });
      start = start + len;                     // never overlap two runs
      break;
    }
  }
  return out;
}

const runKey = (r) => `${r.start}+${r.len}`;
const describe = (r, fps) =>
  `frames ${r.len === 1 ? r.start : `${r.start}-${r.start + r.len - 1}`} ` +
  `(t=${(r.start / fps).toFixed(2)}s) — differs from what brackets it ` +
  `(${r.enter}, ${r.exit}) while those agree (${r.bracket})`;

/**
 * Find dropouts, re-render them, and keep the re-render only if it is
 * measurably better. A run that reproduces the same way twice is authored
 * content, not a race, so it is put back and reported -- never deleted, never
 * looped on.
 *
 * Repairs run in a deliberately calmer configuration than the main pass: fewer
 * workers and a longer settle. The artefact IS a race, so re-running it under
 * exactly the conditions that lost the race the first time is the one approach
 * guaranteed to be unconvincing.
 */
export async function sweepDropouts(cfg, sink, total, opts = {}) {
  const dir = sink.dir;
  const t0 = Date.now();
  const passes = Math.max(1, opts.passes || 2);
  const fps = cfg.fps || 30;

  const allFound = [], allRepaired = [], allKept = [];
  const attempted = new Set();      // loop guard: never retry a run we judged
  let scanned = 0;

  for (let pass = 1; pass <= passes; pass++) {
    process.stdout.write(c.dim(`  scanning frames for paint dropouts...\r`));
    const sig = frameSignatures(dir, total);
    if (!sig) {
      console.log(c.y('  Could not scan frames for dropouts (ffmpeg read failed); skipping.'));
      break;
    }
    scanned = sig.count;

    const found = detectDropouts(sig, opts).filter((r) => !attempted.has(runKey(r)));
    process.stdout.write(' '.repeat(64) + '\r');

    if (!found.length) {
      if (pass === 1) {
        console.log(`  ${c.g('No paint dropouts found')} ` +
          c.dim(`(${sig.count} frames scanned in ${fmtDuration((Date.now() - t0) / 1000)})`));
      }
      break;
    }

    const flagged = found.reduce((n, r) => n + r.len, 0);
    console.log(c.y(`  ${found.length} suspected dropout${found.length > 1 ? 's' : ''}` +
      `${pass > 1 ? ` (pass ${pass})` : ''}, ${flagged} frame(s):`));
    for (const r of found.slice(0, 8)) console.log(c.dim(`    ${describe(r, fps)}`));
    if (found.length > 8) console.log(c.dim(`    ...and ${found.length - 8} more`));

    for (const r of found) attempted.add(runKey(r));
    allFound.push(...found);

    // Keep the originals so a repair can be rejected.
    const targets = found.flatMap((r) => r.frames);
    const backup = new Map();
    for (const i of targets) {
      try { backup.set(i, fs.readFileSync(sink.pathFor(i))); } catch {}
      sink.remove(i);
    }

    const t0off = cfg.timeOffset || 0;
    const careful = {
      ...cfg,
      jobs: targets.length <= 24 ? 1 : Math.min(cfg.jobs, 2),
      settleMs: Math.max(cfg.settleMs || 0, 120),
    };
    await runCapture(careful, targets.map((i) => ({ index: i, time: t0off + i / fps })),
      sink, { label: `Re-rendering dropouts${pass > 1 ? ` (pass ${pass})` : ''}` });

    const sig2 = frameSignatures(dir, total);
    let repairedThisPass = 0;

    for (const r of found) {
      const restore = () => {
        for (const i of r.frames) {
          const b = backup.get(i);
          if (b) sink.write(i, b);
        }
      };
      if (r.frames.some((i) => !sink.has(i))) { restore(); allKept.push(r); continue; }

      const after = sig2 ? runMetrics(sig2, r.start, r.len) : null;
      // Accept only a repair that is better on every axis: the run now blends
      // into what surrounds it AND neither boundary got worse. A change that
      // merely swaps one wrong frame for a different wrong frame fails this.
      const better = after &&
        after.ratio > r.ratio * 1.5 &&
        after.enter <= r.enter + 1e-6 &&
        after.exit <= r.exit + 1e-6;

      if (better) { allRepaired.push(r); repairedThisPass++; }
      else { restore(); allKept.push(r); }
    }

    if (!repairedThisPass) break;      // nothing improved; another pass cannot help
  }

  const repairedFrames = allRepaired.flatMap((r) => r.frames);
  const keptFrames = allKept.flatMap((r) => r.frames);

  if (repairedFrames.length) {
    console.log(`  ${c.g(`Repaired ${repairedFrames.length} frame(s)`)}: ` +
      `${summariseRanges(repairedFrames).slice(0, 160)}`);
  }
  if (keptFrames.length) {
    console.log(c.dim(`  ${keptFrames.length} frame(s) reproduced identically — ` +
      `authored content, left as-is: ${summariseRanges(keptFrames).slice(0, 160)}`));
  }

  return {
    checked: scanned,
    found: allFound.flatMap((r) => r.frames),
    runs: allFound,
    repaired: repairedFrames,
    kept: keptFrames,
  };
}
