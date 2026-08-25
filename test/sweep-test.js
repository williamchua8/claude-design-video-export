#!/usr/bin/env node
// Unit check for the dropout detector, using synthetic frame signatures.
//
// The detector's whole value rests on being SPECIFIC: it must fire on a short
// run of frames that lost content, and must not fire on ordinary motion,
// however fast. These cases encode that contract. Validated separately against
// two real 3840x2160/30 exports of the same project, where it found the true
// dropouts (a two-frame one in the first, two single-frame ones in the second)
// and nothing else in 3120 frames.

import { detectDropouts, detectOutliers, detectCandidates, SENSITIVITY } from '../lib/sweep.js';
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

// ---------------------------------------------------------------------------
// The transition-aware detector
// ---------------------------------------------------------------------------
//
// The run test asks whether the frames bracketing a dropout agree with each
// other. During a cross-fade they never do, so a dropout mid-fade is invisible
// to it. These cases pin down the second detector that covers exactly that.

console.log(c.b('\n  Transition-aware detector\n'));

// A fast cross-fade carrying a small bright panel. The fade step is large
// relative to the panel, which is what real footage looks like -- and what
// makes the bracketing frames disagree, blinding the run test.
const LEVEL = (i) => 10 + i * 20;
const fading = (i, gone) => (x, y) => ((!gone && y >= 8 && y < 10) ? 220 : LEVEL(i));

// A panel that vanishes for two frames in the MIDDLE of a fast fade.
{
  const frames = [];
  for (let i = 0; i < 11; i++) frames.push(fading(i, i === 5 || i === 6));
  const sig = makeSig(frames);

  check('a dropout during a fade is invisible to the run test (this is the gap)',
    detectDropouts(sig).length === 0,
    'the bracketing frames are at different fade levels, so they never agree');

  const hits = detectOutliers(sig).map((h) => h.index);
  check('the transition detector DOES catch it',
    hits.includes(5) && hits.includes(6), `hits=${JSON.stringify(hits)}`);

  const runs = detectCandidates(sig).runs;
  const covered = runs.some((r) => r.frames.includes(5)) && runs.some((r) => r.frames.includes(6));
  check('and the merged candidate list covers both frames', covered,
    JSON.stringify(runs.map((r) => [r.start, r.len, r.source])));
}

// A clean fade with nothing wrong in it must stay silent, however long.
{
  const frames = [];
  for (let i = 0; i < 12; i++) frames.push(fading(i, false));
  const hits = detectOutliers(makeSig(frames));
  check('a clean fade is NOT flagged', hits.length === 0,
    `hits=${JSON.stringify(hits.map((h) => h.index))}`);
}

// Steady fast motion is far from linear frame to frame, but it is CONSISTENTLY
// far, so the local baseline absorbs it.
{
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push((x, y) => (x > (i * 5) % 32 && x < ((i * 5) % 32) + 6 ? 230 : 15));
  const hits = detectOutliers(makeSig(frames));
  check('sustained fast motion is NOT flagged', hits.length === 0,
    `hits=${JSON.stringify(hits.map((h) => h.index))}`);
}

// The first frame after a hard cut is maximally non-linear, but it agrees with
// the frame after it, which is what tells the two apart.
{
  const a = () => 30, b = () => 210;
  const hits = detectOutliers(makeSig([a, a, a, a, b, b, b, b]));
  check('the frame after a hard cut is NOT flagged', hits.length === 0,
    `hits=${JSON.stringify(hits.map((h) => h.index))}`);
}

// Turning the outlier detector off must leave the run test exactly as it was.
{
  const normal = (x, y) => (y > 4 && y < 12 ? 200 : 20);
  const dropped = (x, y) => (y > 8 && y < 12 ? 200 : 20);
  const sig = makeSig([normal, normal, dropped, dropped, normal, normal]);
  const runs = detectCandidates(sig, { outliers: false }).runs;
  check('with the outlier pass off, the run test still stands alone',
    runs.length === 1 && runs[0].start === 2 && runs[0].len === 2,
    JSON.stringify(runs.map((r) => [r.start, r.len])));
}

// ---------------------------------------------------------------------------
// The candidate cap
// ---------------------------------------------------------------------------
//
// A pathological video (or a much noisier compositor than the one this was
// tuned against) could otherwise turn every sweep into a second full render.
// --sweep-max-candidates exists so someone hitting the cap in practice has a
// dial, so the cap itself has to actually cap.

console.log(c.b('\n  Candidate cap\n'));

{
  // Many independent one-frame dropouts scattered through a still video --
  // enough to comfortably exceed the default floor of 40.
  const still = () => 10;
  const spike = (level) => () => level;
  const frames = [];
  for (let i = 0; i < 400; i++) {
    frames.push(i % 6 === 3 ? spike(220) : still);
  }
  const sig = makeSig(frames);

  const uncapped = detectCandidates(sig, { ...SENSITIVITY.normal, maxCandidates: 10000 });
  check('sanity: this synthetic video does produce more than 40 candidates',
    uncapped.runs.length > 40, `runs=${uncapped.runs.length}`);

  // maxCandidates only RAISES the floor (the larger of 40, 3% of the frame
  // count, and maxCandidates) -- it is an escape hatch for a badly affected
  // render, not a way to make the sweep skip more than the safety floor does.
  const atDefault = detectCandidates(sig, { ...SENSITIVITY.normal });
  check('with no override the built-in floor (40 here) still caps the list',
    atDefault.runs.length === 40, `runs=${atDefault.runs.length}`);
  check('and it reports how many it left out',
    atDefault.capped === uncapped.runs.length - atDefault.runs.length,
    `capped=${atDefault.capped}`);

  const raised = detectCandidates(sig, { ...SENSITIVITY.normal, maxCandidates: 60 });
  check('--sweep-max-candidates raises the cap above the default floor',
    raised.runs.length === 60, `runs=${raised.runs.length}`);
}

console.log(`\n  ${failures ? c.r(`${failures} failed`) : c.g('all passed')}\n`);
process.exitCode = failures ? 1 : 0;
