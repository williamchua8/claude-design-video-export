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

import { shootStable } from '../lib/capture.js';
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

console.log(`\n  ${failures ? c.r(`${failures} failed`) : c.g('all passed')}\n`);
process.exitCode = failures ? 1 : 0;
