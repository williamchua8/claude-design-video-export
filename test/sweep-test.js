#!/usr/bin/env node
// Unit check for the dropout detector, using synthetic frame signatures.
//
// The detector's whole value rests on being SPECIFIC: it must fire on a short
// run of frames that lost content, and must not fire on ordinary motion,
// however fast. These cases encode that contract. Validated separately against
// two real 3840x2160/30 exports of the same project, where it found the true
// dropouts (a two-frame one in the first, two single-frame ones in the second)
// and nothing else in 3120 frames.

import { detectDropouts } from '../lib/sweep.js';
import { c } from '../lib/util.js';

const W = 32, H = 18, FB = W * H;

/** Build a signature buffer from a list of per-frame paint functions. */
function makeSig(frames) {
  const data = Buffer.alloc(frames.length * FB);
  frames.forEach((paint, i) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[i * FB + y * W + x] = paint(x, y);
  });
  return { data, width: W, height: H, frameBytes: FB, count: frames.length };
}

let failures = 0;
const check = (name, pass, detail) => {
  if (!pass) failures++;
  console.log(`  ${pass ? c.g('PASS') : c.r('FAIL')}  ${name}${detail ? c.dim('  — ' + detail) : ''}`);
};

console.log(c.b('\n  Dropout detector\n'));

// A panel sitting still, with one frame where a band of it fails to paint.
{
  const normal = (x, y) => (y > 4 && y < 12 ? 200 : 20);
  const dropped = (x, y) => (y > 8 && y < 12 ? 200 : 20);   // top half of the panel gone
  const sig = makeSig([normal, normal, normal, dropped, normal, normal]);
  const hits = detectDropouts(sig);
  check('a one-frame partial paint failure is detected',
    hits.length === 1 && hits[0].index === 3,
    `hits=${JSON.stringify(hits.map((x) => x.index))}`);
}

// A panel sliding across the frame: every frame differs from the last, and
// i-1/i+1 are the FURTHEST apart, which is the opposite of the signature.
{
  const frames = [];
  for (let i = 0; i < 10; i++) frames.push((x, y) => (x > i * 2 && x < i * 2 + 8 ? 220 : 15));
  const hits = detectDropouts(makeSig(frames));
  check('fast linear motion is NOT flagged', hits.length === 0,
    `hits=${JSON.stringify(hits.map((x) => x.index))}`);
}

// A hard cut between two scenes: one big change, but it does not revert.
{
  const a = () => 30, b = () => 210;
  const hits = detectDropouts(makeSig([a, a, a, b, b, b]));
  check('a scene cut is NOT flagged', hits.length === 0,
    `hits=${JSON.stringify(hits.map((x) => x.index))}`);
}

// A legitimate one-frame flash that the composition actually authored looks
// identical to a dropout from signatures alone -- the detector is EXPECTED to
// flag it. Correctness comes from the repair step, which re-renders and keeps
// the original when it reproduces. This test documents that boundary.
{
  const dark = () => 20, flash = () => 240;
  const hits = detectDropouts(makeSig([dark, dark, flash, dark, dark]));
  check('an authored one-frame flash is flagged (repair step decides, not this)',
    hits.length === 1 && hits[0].index === 2,
    'by design: re-render reproduces it, so the original is kept');
}

// The regression that motivated runs: TWO consecutive frames lose the same
// panel. Each one agrees with the other, so the single-frame test skipped both.
{
  const normal = (x, y) => (y > 4 && y < 12 ? 200 : 20);
  const dropped = (x, y) => (y > 8 && y < 12 ? 200 : 20);
  const sig = makeSig([normal, normal, dropped, dropped, normal, normal]);
  const hits = detectDropouts(sig);
  check('a TWO-frame partial paint failure is detected',
    hits.length === 1 && hits[0].start === 2 && hits[0].len === 2,
    `hits=${JSON.stringify(hits.map((x) => [x.start, x.len]))}`);
}

// Three in a row, still within maxRun.
{
  const normal = (x, y) => (y > 4 && y < 12 ? 200 : 20);
  const dropped = (x, y) => (y > 8 && y < 12 ? 200 : 20);
  const sig = makeSig([normal, normal, dropped, dropped, dropped, normal, normal]);
  const hits = detectDropouts(sig);
  check('a THREE-frame partial paint failure is detected',
    hits.length === 1 && hits[0].start === 2 && hits[0].len === 3,
    `hits=${JSON.stringify(hits.map((x) => [x.start, x.len]))}`);
}

// Long enough to be a real shot rather than a glitch: past maxRun the run test
// stops applying, which is what keeps a short authored insert out of the sweep.
{
  const normal = (x, y) => (y > 4 && y < 12 ? 200 : 20);
  const other = (x, y) => (y > 8 && y < 12 ? 200 : 20);
  const sig = makeSig([normal, normal, other, other, other, other, other, other, normal, normal]);
  const hits = detectDropouts(sig);
  check('a six-frame insert is NOT flagged (longer than maxRun)', hits.length === 0,
    `hits=${JSON.stringify(hits.map((x) => [x.start, x.len]))}`);
}

// A run whose frames do not agree with each other is motion passing through,
// not a dropout holding one broken state.
{
  const a = () => 20;
  const b1 = () => 120, b2 = () => 200;
  const sig = makeSig([a, a, b1, b2, a, a]);
  const hits = detectDropouts(sig);
  check('an incoherent two-frame excursion is NOT flagged', hits.length === 0,
    `hits=${JSON.stringify(hits.map((x) => [x.start, x.len]))}`);
}

// A gentle fade must not trip the minimum-delta guard.
{
  const frames = [];
  for (let i = 0; i < 12; i++) frames.push(() => 20 + i * 3);
  const hits = detectDropouts(makeSig(frames));
  check('a slow fade is NOT flagged', hits.length === 0,
    `hits=${JSON.stringify(hits.map((x) => x.index))}`);
}

console.log(`\n  ${failures ? c.r(`${failures} failed`) : c.g('all passed')}\n`);
process.exitCode = failures ? 1 : 0;
