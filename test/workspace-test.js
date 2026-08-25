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
import { projectKey, bundleNames, framesDir, acquireLock, readLock, LOCK_STALE_MS } from '../lib/workspace.js';
import { resolveQueue } from '../lib/queue.js';
import { legacyFramesDir, adoptLegacyFrames } from '../lib/pipeline.js';
import { c } from '../lib/util.js';

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
