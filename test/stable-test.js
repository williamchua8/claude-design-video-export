#!/usr/bin/env node
// Contract tests for stable capture (lib/capture.js shootStable).
//
// The whole claim behind this feature is that it has NO FALSE POSITIVES: every
// clock in the page is pinned, so a correctly rastered frame is byte-identical
// however many times you screenshot it, and therefore any disagreement between
// consecutive shots is the compositor handing over a half-drawn picture. These
// cases pin down the loop that acts on that: it must settle immediately when
// the picture is already stable (costing exactly one extra shot), keep shooting
// while it changes, and give up rather than spin when it never settles.

import { shootStable, makeStableState, stableNeedFor, stableObserve, PROBE_FRAMES, SPOT_CHECK_EVERY } from '../lib/capture.js';
import { c } from '../lib/util.js';

let failures = 0;
const check = (name, pass, detail) => {
  if (!pass) failures++;
  console.log(`  ${pass ? c.g('PASS') : c.r('FAIL')}  ${name}${detail ? c.dim('  — ' + detail) : ''}`);
};

/** A fake camera that returns each scripted frame in turn, repeating the last. */
const camera = (script) => {
  let i = 0;
  const calls = [];
  const fn = async () => {
    const v = script[Math.min(i, script.length - 1)];
    i++; calls.push(v);
    return Buffer.from(v);
  };
  fn.calls = calls;
  return fn;
};

console.log(c.b('\n  Stable capture\n'));

// The overwhelmingly common case: nothing was wrong, so it settles at once.
{
  const cam = camera(['good']);
  const r = await shootStable(cam);
  check('an already-complete frame settles on the second shot',
    r.stable && r.shots === 2 && r.buf.toString() === 'good', `shots=${r.shots}`);
  check('and costs exactly one extra screenshot, not more', cam.calls.length === 2,
    `calls=${cam.calls.length}`);
}

// The bug this exists for: the first shot is half-drawn, the rest are complete.
{
  const cam = camera(['HALF-DRAWN', 'good', 'good']);
  const r = await shootStable(cam);
  check('a half-drawn first shot is discarded for the settled picture',
    r.stable && r.buf.toString() === 'good', `got=${r.buf.toString()} shots=${r.shots}`);
  check('and it takes three shots to prove it settled', r.shots === 3, `shots=${r.shots}`);
}

// Two bad shots in a row, each different, then it comes good.
{
  const cam = camera(['bad1', 'bad2', 'good', 'good']);
  const r = await shootStable(cam, { need: 2, tries: 6 });
  check('it keeps shooting while the picture is still changing',
    r.stable && r.buf.toString() === 'good', `got=${r.buf.toString()} shots=${r.shots}`);
}

// Never settles: must bail out rather than spin forever, and must SAY it did
// not settle so the sweep still looks at the frame.
{
  const cam = camera(['a', 'b', 'c', 'd', 'e', 'f']);
  const r = await shootStable(cam, { need: 2, tries: 4 });
  check('a frame that never settles gives up at the try limit',
    !r.stable && r.shots === 4, `stable=${r.stable} shots=${r.shots}`);
  check('and still returns a usable frame rather than nothing',
    Buffer.isBuffer(r.buf) && r.buf.length > 0);
}

// Two identical shots can happen by luck on a badly flickering layer, so the
// threshold is adjustable.
{
  const cam = camera(['x', 'x', 'y', 'z', 'z', 'z']);
  const r2 = await shootStable(camera(['x', 'x', 'y', 'z', 'z', 'z']), { need: 2, tries: 8 });
  check('need=2 accepts the first coincidence', r2.buf.toString() === 'x', r2.buf.toString());
  const r3 = await shootStable(cam, { need: 3, tries: 8 });
  check('need=3 holds out for three in a row',
    r3.stable && r3.buf.toString() === 'z', `got=${r3.buf.toString()} shots=${r3.shots}`);
}

// A run that agrees, then changes, must not count the earlier agreement.
{
  const cam = camera(['p', 'p', 'q']);
  const r = await shootStable(cam, { need: 3, tries: 3 });
  check('the agreement streak resets when the picture changes again',
    !r.stable, `stable=${r.stable}`);
}

// ---------------------------------------------------------------------------
// Adaptive mode
// ---------------------------------------------------------------------------
//
// Whether a machine hands over half-drawn frames is a property of its driver
// and its load, and the people it happens to are exactly the people who do not
// know to reach for a flag. So the default measures instead of asking. These
// cases pin down that it costs a clean machine almost nothing, protects an
// affected one without being told to, and cannot get stuck in the wrong answer.

console.log(c.b('\n  Adaptive stable capture\n'));

/** Run n frames through the state machine; `bad` says which ones misbehave. */
const drive = (st, n, bad = () => false) => {
  const needs = [];
  let carefulBeforeOn = 0;
  for (let i = 0; i < n; i++) {
    const need = stableNeedFor(st);
    needs.push(need);
    if (st.mode !== 'on' && need >= 2) carefulBeforeOn++;
    const misbehaved = need >= 2 && bad(i);
    stableObserve(st, { need, shots: misbehaved ? need + 1 : need, stable: true });
  }
  needs.carefulBeforeOn = carefulBeforeOn;
  return needs;
};

{
  const st = makeStableState({ stableCapture: 'auto' });
  check('auto starts by probing', st.mode === 'probing' && stableNeedFor(st) === 2);
}

{
  // A machine that never misbehaves: probe, then run at full speed.
  const st = makeStableState({ stableCapture: 'auto' });
  const N = 400;
  const needs = drive(st, N);
  const careful = needs.filter((n) => n >= 2).length;
  // Probe burst up front, then a spot check every SPOT_CHECK_EVERY frames. The
  // number that matters is the ceiling: this must stay a few percent, not creep
  // toward doubling every screenshot.
  const budget = PROBE_FRAMES + Math.ceil((N - PROBE_FRAMES) / SPOT_CHECK_EVERY) + 1;
  check('a clean machine settles to occasional spot checks, not every frame',
    st.mode === 'off' && careful <= budget && careful < N * 0.12,
    `careful=${careful} of ${N} (budget ${budget}) mode=${st.mode}`);
}

{
  // One bad frame during the probe is enough to commit for the whole run.
  const st = makeStableState({ stableCapture: 'auto' });
  const needs = drive(st, 100, (i) => i === 3);
  check('one half-drawn frame during probing turns it on for the rest',
    st.mode === 'on' && needs.slice(20).every((n) => n >= 2), `mode=${st.mode}`);
}

{
  // A machine that only starts misbehaving once warm must still be caught.
  const st = makeStableState({ stableCapture: 'auto' });
  drive(st, PROBE_FRAMES + 5);
  check('sanity: it went to full speed first', st.mode === 'off');
  const needs = drive(st, SPOT_CHECK_EVERY + 5, () => true);
  check('a spot check catches a machine that degrades later',
    st.mode === 'on', `mode=${st.mode}`);
  // The cost of insurance is what matters here: exactly one careful frame is
  // spent before the problem is found, not a steady tax on every frame.
  check('and costs exactly one careful frame to notice',
    needs.carefulBeforeOn === 1, `careful-before-on=${needs.carefulBeforeOn}`);
  check('and the frames before the catch were mostly full speed',
    needs.filter((n) => n === 1).length >= SPOT_CHECK_EVERY - 6,
    `single-shot=${needs.filter((n) => n === 1).length} of ${needs.length}`);
}

{
  // Explicit settings must not be second-guessed by the adaptive logic.
  const on = makeStableState({ stableCapture: 3 });
  check('an explicit --stable-capture is honoured exactly',
    on.mode === 'on' && stableNeedFor(on) === 3);
  drive(on, 50);
  check('and never downgrades itself', on.mode === 'on' && stableNeedFor(on) === 3);

  const off = makeStableState({ stableCapture: 'off' });
  check('--no-stable-capture stays off', off.mode === 'off' && stableNeedFor(off) === 1);
  drive(off, 50);
  check('and never re-probes', stableNeedFor(off) === 1);
}

{
  // The case that motivated spot-checking at all: a long render whose fragile
  // scene arrives ~1500 frames in. Probing only the opening frames declares the
  // machine clean and then never looks again, so the race is never sampled.
  const st = makeStableState({ stableCapture: 'auto' });
  const LATE = 1500;
  const needs = drive(st, LATE + 200, (i) => i >= LATE);   // only misbehaves late
  check('a scene that only misbehaves 1500 frames in is still caught',
    st.mode === 'on', `mode=${st.mode}`);
  const carefulEarly = needs.slice(PROBE_FRAMES, LATE).filter((n) => n >= 2).length;
  check('and the sampling before it stayed cheap',
    carefulEarly <= (LATE - PROBE_FRAMES) / SPOT_CHECK_EVERY + 2,
    `careful=${carefulEarly} of ${LATE - PROBE_FRAMES} frames`);
}

console.log(`\n  ${failures ? c.r(`${failures} failed`) : c.g('all passed')}\n`);
process.exitCode = failures ? 1 : 0;
