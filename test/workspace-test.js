#!/usr/bin/env node
// Contract tests for frame-folder isolation, locking and the render queue.
//
// These encode the failure the whole workspace module exists to prevent: two
// compositions from one project sharing a frame folder, so the second render
// silently inherits the first one's pictures. That bug is invisible in the
// output -- the video plays, it is just the wrong video -- so it needs a test
// rather than a careful reading.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { projectKey, bundleNames, framesDir, acquireLock, readLock, LOCK_STALE_MS } from '../lib/workspace.js';
import { DiskSink } from '../lib/frames.js';
import { parseFrameSelection } from '../lib/util.js';
import { resolveQueue } from '../lib/queue.js';
import { legacyFramesDir, adoptLegacyFrames } from '../lib/pipeline.js';
import { c } from '../lib/util.js';

/** A tiny but structurally real PNG, so DiskSink's validity checks pass. */
function makeTestPng(w = 8, h = 8) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 3));            // filter byte 0 + RGB per row
  // level 0 so the file comfortably clears DiskSink's truncation floor
  // instead of deflating an all-zero image down to a handful of bytes.
  const idat = zlib.deflateSync(raw, { level: 0 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

let failures = 0;
const check = (name, pass, detail) => {
  if (!pass) failures++;
  console.log(`  ${pass ? c.g('PASS') : c.r('FAIL')}  ${name}${detail ? c.dim('  — ' + detail) : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdv-ws-'));
const cfgFor = (projectId, over = {}) => ({
  projectId, workDir: tmp, fps: 30, sceneTag: '',
  geom: { captureW: 1920, captureH: 1080, scaleMode: 'dpr' },
  ...over,
});

console.log(c.b('\n  Workspace: frame folders, locks, queue\n'));

// ---- identity --------------------------------------------------------------
{
  const root = '/proj';
  const a = projectKey(root, '/proj/intro/index.html', 'myzip');
  const b = projectKey(root, '/proj/outro/index.html', 'myzip');
  check('two compositions in one project get different ids', a.id !== b.id,
    `${a.id} vs ${b.id}`);
  check('the id survives a re-run unchanged',
    projectKey(root, '/proj/intro/index.html', 'myzip').id === a.id, a.id);
}

{
  const names = bundleNames([
    { rel: 'intro/index.html' }, { rel: 'outro/index.html' },
    { rel: 'index.html' }, { rel: 'deep/nest/scene.html' },
  ]);
  check('index.html files are named by their folder, not the file',
    names[0] === 'intro' && names[1] === 'outro',
    JSON.stringify(names));
  check('a nested non-generic name keeps its path', names[3] === 'deep-nest-scene', names[3]);
  check('every composition gets a distinct name',
    new Set(names).size === names.length, JSON.stringify(names));
}

// THE regression: four videos all called index.html must not collapse into one.
{
  const rels = ['a/index.html', 'b/index.html', 'c/index.html', 'd/index.html'];
  const names = bundleNames(rels.map((rel) => ({ rel })));
  const dirs = names.map((n, i) =>
    framesDir(cfgFor(projectKey('/p', '/p/' + rels[i], 'zip', n).id)));
  check('four index.html bundles get four frame folders',
    new Set(dirs).size === 4, JSON.stringify(names));
  check('four index.html bundles get four output names',
    new Set(names).size === 4, JSON.stringify(names));
}

{
  const base = cfgFor('proj-abc123');
  check('scene selections are filed separately from the full render',
    framesDir(base) !== framesDir({ ...base, sceneTag: '_IPAM' }));
  check('resolution and fps still separate folders',
    framesDir(base) !== framesDir({ ...base, fps: 60 }));
}

// ---- locking ----------------------------------------------------------------
{
  const dir = path.join(tmp, 'lockdir');
  const first = acquireLock(dir, { what: 'test' });
  check('a free frame folder can be claimed', first.ok);

  const second = acquireLock(dir, { what: 'test' });
  check('a second render is refused while the first holds it',
    !second.ok && second.reason === 'busy',
    second.ok ? 'it was allowed in' : `held by pid ${second.holder.pid}`);

  first.release();
  const third = acquireLock(dir, { what: 'test' });
  check('releasing hands the folder to the next render', third.ok);
  third.release();
  check('release removes the lock file', readLock(dir) === null);
}

{
  // A killed render must not lock a folder forever.
  const dir = path.join(tmp, 'staledir');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.render-lock.json'), JSON.stringify({
    token: 'x', pid: 999999, host: os.hostname(),
    started: Date.now() - LOCK_STALE_MS * 2, beat: Date.now() - LOCK_STALE_MS * 2,
  }));
  const got = acquireLock(dir, {});
  check('a stale lock from a dead process is reclaimed', got.ok);
  if (got.ok) got.release();
}

// ---- legacy adoption ---------------------------------------------------------
{
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cdv-legacy-'));
  const cfg = { ...cfgFor('proj-xyz'), workDir: work, bundleCount: 1 };
  const old = legacyFramesDir(cfg);
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'frame_000000.png'), 'not-a-real-png');

  const r = adoptLegacyFrames(cfg);
  check('frames from the old layout are adopted, not abandoned',
    r && r.moved && fs.existsSync(path.join(framesDir(cfg), 'frame_000000.png')));
  check('the old folder is gone once its frames were moved', !fs.existsSync(old));
}

{
  // With more than one composition there is no way to know whose frames those
  // are, so the only safe answer is to leave them where they are.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cdv-legacy2-'));
  const cfg = { ...cfgFor('proj-xyz'), workDir: work, bundleCount: 3 };
  const old = legacyFramesDir(cfg);
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'frame_000000.png'), 'x');

  const r = adoptLegacyFrames(cfg);
  check('ambiguous legacy frames are left untouched',
    r && !r.moved && fs.existsSync(path.join(old, 'frame_000000.png')), r && r.why);
}

// ---- scene frame numbering -----------------------------------------------
//
// Rendering only one scene must not restart frame numbering at 0. The whole
// point is that the frames a scene writes land at the exact filename they
// would have in a full render of the video, so a scene rendered on a second
// machine can be dropped straight into the same frames folder as everything
// else -- no renaming, no bookkeeping about which scene is which.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdv-offset-'));
  const OFFSET = 960;                      // e.g. a scene starting at t=32s, 30fps
  const sink = new DiskSink(dir, 8, 8, OFFSET);
  const pngA = makeTestPng(), pngB = makeTestPng();

  sink.write(0, pngA);
  sink.write(1, pngB);

  check('a scene\'s first frame is filed under the FULL VIDEO\'s frame number',
    fs.existsSync(path.join(dir, 'frame_000960.png')),
    fs.readdirSync(dir).join(','));
  check('the render still sees it at its own local index 0',
    sink.has(0) && sink.take(0).equals(pngA));
  check('nothing is written at local index 0\'s literal filename',
    !fs.existsSync(path.join(dir, 'frame_000000.png')));

  check('missing() still reports LOCAL gaps, not global ones',
    JSON.stringify(sink.missing(4)) === JSON.stringify([2, 3]),
    JSON.stringify(sink.missing(4)));

  // sizeConflicts() reads filenames straight off disk (already global) and
  // must not run them through the offset a second time.
  check('sizeConflicts reads its own frame back without double-applying the offset',
    sink.sizeConflicts() === null);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

{
  // --redo takes frame numbers and timestamps against the FULL VIDEO -- the
  // same numbers printed everywhere else and baked into the filenames above --
  // not against the scene's own local position.
  const fps = 30, offset = 960, total = 450;   // a 15s scene, 32s-47s of the video
  check('--redo by GLOBAL frame number lands on the right LOCAL index',
    JSON.stringify(parseFrameSelection('1000', fps, total, offset)) === JSON.stringify([40]));
  check('--redo by absolute timestamp also lands on the right LOCAL index',
    JSON.stringify(parseFrameSelection('33s', fps, total, offset)) === JSON.stringify([30]));
  check('a timestamp before this scene starts yields nothing',
    parseFrameSelection('10s', fps, total, offset).length === 0);
  check('a timestamp after this scene ends yields nothing',
    parseFrameSelection('50s', fps, total, offset).length === 0);
  check('a whole-video render (offset 0) is unaffected',
    JSON.stringify(parseFrameSelection('48s', fps, 1560, 0)) === JSON.stringify([1440]));
}

// ---- queue selection ----------------------------------------------------------
{
  const bundles = [
    { rel: 'intro/index.html' }, { rel: 'body/index.html' },
    { rel: 'outro/index.html' }, { rel: 'extra/index.html' },
  ];
  const rels = (x) => resolveQueue(bundles, x).map((b) => b.rel.split('/')[0]).join(',');
  check('--queue all takes everything', rels('all') === 'intro,body,outro,extra');
  check('--queue with no value takes everything', rels('') === 'intro,body,outro,extra');
  check('--queue 2-3 takes a range', rels('2-3') === 'body,outro');
  check('--queue 1,4 takes a list', rels('1,4') === 'intro,extra');
  check('--queue by name matches the path', rels('outro') === 'outro');
  check('--queue keeps project order, not the order typed', rels('4,1') === 'intro,extra');
  check('--queue with no match returns nothing', resolveQueue(bundles, 'nope').length === 0);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n  ${failures ? c.r(`${failures} failed`) : c.g('all passed')}\n`);
process.exitCode = failures ? 1 : 0;
