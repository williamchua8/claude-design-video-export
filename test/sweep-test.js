#!/usr/bin/env node
// Unit check for the dropout detector, using synthetic frame signatures.
//
// The detector's whole value rests on being SPECIFIC: it must fire on a frame
// that lost content for one frame, and must not fire on ordinary motion,
// however fast. These cases encode that contract. Validated separately against
// a real 4K export, where it found the one true dropout in a 50-frame window
// and nothing else.

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
