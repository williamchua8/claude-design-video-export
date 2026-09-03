// ---------------------------------------------------------------------------
// Workspace: where a render's frames live, and who owns them
// ---------------------------------------------------------------------------
//
// THE "MY FRAMES GOT EATEN" FIX.
//
// Frames used to be filed under
//
//     <workDir>/frames/<W>x<H>@<fps>
//
// which is keyed by the OUTPUT FORMAT and nothing else. That is fine for one
// video and actively destructive for two, because a Claude Code zip routinely
// holds several compositions and they all resolve to the same workDir:
//
//   * render video A, then video B at the same size and frame rate, and B sees
//     A's frames sitting in "its" folder, reports them as already done, and
//     encodes A's pictures into B's mp4;
//   * or you pass --fresh and B deletes A's frames outright;
//   * or you run both at once and two processes interleave writes into one
//     folder, so each of them encodes a mixture of the two.
//
// None of those announce themselves. The frames are all the right SIZE, so the
// existing size-conflict guard stays quiet, and the resulting video looks
// plausible until you watch it.
//
// So a frame folder is now keyed by WHICH COMPOSITION it belongs to as well as
// what shape it is:
//
//     <workDir>/frames/<project-slug>/<W>x<H>@<fps><scene tag>
//
// and while a render is using one, it holds a lock file there. A second render
// that wants the same folder is told who has it rather than quietly joining in.
//
// Identity is the entry file's path INSIDE the project, not a hash of its
// contents. That is deliberate: hashing would give every edit of the bundle a
// brand-new folder and silently orphan the frames you already paid for, which
// is the opposite of what this module is for. The content hash is recorded in
// settings.json instead, so a changed bundle produces a warning you can act on
// rather than a surprise.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { c } from './util.js';

const LOCK = '.render-lock.json';

// A lock is heartbeated while a render runs. Anything older than this is from a
// process that was killed, and reclaiming it is the right call -- otherwise a
// single crash would leave the folder unusable until someone deleted a dotfile
// they do not know about.
export const LOCK_STALE_MS = 90_000;
export const LOCK_BEAT_MS = 15_000;

export function slug(s, max = 40) {
  return String(s || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max) || 'project';
}

export const shortHash = (s, n = 6) =>
  crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);

export function fileHash(fp) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(fp)).digest('hex').slice(0, 12); }
  catch { return null; }
}

// Names that say nothing about which composition this is. When a bundle sits at
// "intro/index.html" the folder is the name and the file is noise.
const GENERIC_ENTRY = /^(index|main|app|render|video|animation|bundled?[-_]?page)$/i;

/**
 * A readable, collision-free name for every composition in a project.
 *
 * This matters as much as the frame folder does. A Claude Code zip typically
 * holds "intro/index.html", "outro/index.html" and so on -- every one of them
 * called index.html. Naming the output after the file alone gives every video
 * in the queue the same file name, and the last one rendered is the only one
 * you keep. The path is what carries the identity, so the path is what names it.
 *
 * @returns {string[]} one name per bundle, in the order given
 */
export function bundleNames(bundles) {
  const raw = bundles.map((b) => {
    const parts = String(b.rel || '').replace(/\.[a-z0-9]+$/i, '').split('/').filter(Boolean);
    if (parts.length > 1 && GENERIC_ENTRY.test(parts[parts.length - 1])) parts.pop();
    return slug(parts.join('-'));
  });
  const counts = raw.reduce((m, n) => m.set(n, (m.get(n) || 0) + 1), new Map());
  // Two bundles whose paths slug to the same thing still have different paths,
  // so fall back to the path hash rather than letting them share a name.
  return raw.map((n, i) => (counts.get(n) > 1 ? `${n}-${shortHash(bundles[i].rel)}` : n));
}

/**
 * A stable, human-readable id for one composition inside one project.
 *
 * @param {string} rootDir    project root (the folder, or where the zip unpacked)
 * @param {string} entryFile  the .html actually being rendered
 * @param {string} baseName   the project's own name (zip/folder name)
 */
export function projectKey(rootDir, entryFile, baseName, displayName = null) {
  const rel = path.relative(rootDir, entryFile).split(path.sep).join('/') || path.basename(entryFile);
  const base = slug(baseName);
  const head = slug(displayName || bundleNames([{ rel }])[0]);
  // The path hash is what separates two bundles that happen to share a file
  // name -- "scene/index.html" and "intro/index.html" are different videos.
  const label = base && base !== head ? `${base}_${head}` : head;
  return { id: `${label}-${shortHash(rel)}`, rel, base, name: head };
}

/** Where this exact render's frames belong. */
export function framesDir(cfg) {
  const tag = (cfg.sceneTag || '') + (cfg.geom.scaleMode === 'layout' ? '-layout' : '');
  return path.join(cfg.workDir, 'frames', cfg.projectId || 'project',
    `${cfg.geom.captureW}x${cfg.geom.captureH}@${cfg.fps}${tag}`);
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

const alive = (pid) => {
  if (!pid || pid === process.pid) return pid === process.pid;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

export function readLock(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, LOCK), 'utf8')); } catch { return null; }
}

/**
 * Claim a frame folder for this process.
 *
 * @returns {{ok:true, release:Function} | {ok:false, holder:object, reason:string}}
 */
export function acquireLock(dir, meta = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK);
  const held = readLock(dir);

  if (held && held.token !== undefined) {
    const sameHost = held.host === os.hostname();
    const fresh = Date.now() - (held.beat || held.started || 0) < LOCK_STALE_MS;
    // Only a lock from a process we can SEE is still running counts. A stale
    // timestamp from a dead pid, or any lock from another machine on a shared
    // drive that has stopped beating, is reclaimable.
    if (fresh && (!sameHost || alive(held.pid))) {
      return { ok: false, holder: held, reason: 'busy' };
    }
  }

  const token = crypto.randomBytes(8).toString('hex');
  const write = () => {
    try {
      fs.writeFileSync(file, JSON.stringify({
        token, pid: process.pid, host: os.hostname(),
        started: held && held.token === token ? held.started : Date.now(),
        beat: Date.now(), ...meta,
      }, null, 2));
    } catch {}
  };
  write();

  const beat = setInterval(write, LOCK_BEAT_MS);
  if (beat.unref) beat.unref();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    // Never delete a lock that has been taken over by someone else in the
    // meantime -- that would hand a third process a folder already in use.
    const now = readLock(dir);
    if (!now || now.token === token) { try { fs.unlinkSync(file); } catch {} }
  };
  process.once('exit', release);
  return { ok: true, release, token };
}

export function describeHolder(h) {
  if (!h) return 'another render';
  const age = h.beat ? Math.round((Date.now() - h.beat) / 1000) : null;
  return `pid ${h.pid} on ${h.host}` +
    (h.what ? ` (${h.what})` : '') +
    (age != null ? `, last seen ${age}s ago` : '');
}
