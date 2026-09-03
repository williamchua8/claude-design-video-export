// ---------------------------------------------------------------------------
// Frame storage
// ---------------------------------------------------------------------------
//
// Frames are written atomically and validated structurally, because that is what
// makes "resume" trustworthy. A machine that dies mid-write leaves a file with a
// valid PNG header and a truncated body; resuming over that bakes a corrupt
// frame into the master. Checking for the IEND chunk catches it.
//
// Note what is deliberately NOT here: any heuristic that judges a frame by its
// FILE SIZE. A legitimately near-black frame -- a fade, a transition, a hold on
// a dark shot -- compresses far smaller than its neighbours as a completely
// normal authored property of that timestamp. Flagging those produces an
// infinite repair loop, because re-rendering them yields the same small file
// every time.

import fs from 'node:fs';
import path from 'node:path';

const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

export const frameName = (i) => `frame_${String(i).padStart(6, '0')}.png`;

export function readPngSizeBuf(buf) {
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function readPngSize(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  const buf = Buffer.alloc(24);
  try { fs.readSync(fd, buf, 0, 24, 0); } finally { fs.closeSync(fd); }
  return readPngSizeBuf(buf);
}

/** 'ok' | 'missing' | 'truncated' | 'corrupt' | 'wrong-size' */
export function pngStatus(file, expW = 0, expH = 0) {
  let st;
  try { st = fs.statSync(file); } catch { return 'missing'; }
  if (st.size < 128) return 'truncated';
  const dim = readPngSize(file);
  if (!dim) return 'corrupt';
  const tail = Buffer.alloc(12);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, tail, 0, 12, st.size - 12); } finally { fs.closeSync(fd); }
  if (!tail.equals(PNG_IEND)) return 'truncated';
  if (expW && (dim.width !== expW || dim.height !== expH)) return 'wrong-size';
  return 'ok';
}

export function writeAtomic(file, buf) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, buf); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

export function cleanTemp(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  }
}

export function listFrameIndices(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((f) => /^frame_(\d{6})\.png$/.exec(f))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10))
    .sort((a, b) => a - b);
}

/**
 * Frames already on disk and complete, so a re-run never redoes finished work.
 *
 * `offset` maps the LOCAL index used everywhere else in the pipeline (0 at the
 * first frame of THIS render) onto the filename actually written to disk. It
 * exists for scene renders: without it, rendering just the IPAM scene writes
 * frame_000000.png, frame_000001.png... even though those frames sit at
 * t=32s-47s of the full timeline. That is fine until you try to render one
 * scene on a second, faster machine and drop its frames into the folder next
 * to the rest of the video -- there is no number that says where they go. With
 * the offset, that same scene writes frame_000960.png onward (32s * 30fps),
 * which is exactly where they belong in the full render's numbering, and the
 * two machines' output slots together without anyone renaming a file.
 */
export class DiskSink {
  constructor(dir, expW = 0, expH = 0, offset = 0, cacheLimit = 24) {
    this.dir = dir; this.expW = expW; this.expH = expH;
    this.offset = Math.max(0, offset | 0);
    // Frames written moments ago are usually the ones the encoder is about to
    // ask for, so hand those back from memory instead of re-reading them. The
    // file is still on disk, so resume is unaffected.
    this.cache = new Map();
    this.cacheLimit = cacheLimit;
    fs.mkdirSync(dir, { recursive: true });
    cleanTemp(dir);
  }
  /** LOCAL index (0 at this render's first frame) -> the file it lives in. */
  pathFor(i) { return path.join(this.dir, frameName(i + this.offset)); }
  has(i) { return pngStatus(this.pathFor(i), this.expW, this.expH) === 'ok'; }
  write(i, buf) {
    writeAtomic(this.pathFor(i), buf);
    this.cache.set(i, buf);
    while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
  }
  read(i) { return fs.readFileSync(this.pathFor(i)); }
  /** Read once and release: what the encoder feeder uses. */
  take(i) {
    const hit = this.cache.get(i);
    if (hit) { this.cache.delete(i); return hit; }
    return fs.readFileSync(this.pathFor(i));
  }
  remove(i) { try { fs.unlinkSync(this.pathFor(i)); } catch {} }
  /** Indices in [0,total) that are absent or incomplete. */
  missing(total) {
    const out = [];
    for (let i = 0; i < total; i++) if (!this.has(i)) out.push(i);
    return out;
  }
  /**
   * Guard against mixing frames from two different runs.
   * listFrameIndices() returns numbers already read off the filenames on disk
   * (global, offset already baked in), so this reads them directly rather than
   * through pathFor() -- routing a global number back through pathFor would
   * add the offset a second time and open the wrong file.
   */
  sizeConflicts(limit = 400) {
    const seen = new Map();
    for (const i of listFrameIndices(this.dir).slice(0, limit)) {
      const d = readPngSize(path.join(this.dir, frameName(i)));
      if (!d) continue;
      const k = `${d.width}x${d.height}`;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    return seen.size > 1 ? seen : null;
  }
}
