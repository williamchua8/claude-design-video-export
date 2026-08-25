// Small shared helpers. Nothing here knows about browsers or ffmpeg.

import crypto from 'node:crypto';

export const c = {
  b:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g:   (s) => `\x1b[32m${s}\x1b[0m`,
  y:   (s) => `\x1b[33m${s}\x1b[0m`,
  r:   (s) => `\x1b[31m${s}\x1b[0m`,
  cy:  (s) => `\x1b[36m${s}\x1b[0m`,
};

export const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
export const even = (n) => Math.round(n / 2) * 2;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function fmtDuration(s) {
  if (!isFinite(s) || s <= 0) return '--';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export const fmtBytes = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB`
  : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB`
  : `${(n / 1e3).toFixed(0)} KB`;

/** "0,1,2,5,6,9" -> "0-2,5-6,9" so long gap lists stay readable. */
export function summariseRanges(list) {
  if (!list.length) return '';
  const s = [...list].sort((a, b) => a - b);
  const out = [];
  let start = s[0], prev = s[0];
  for (let k = 1; k <= s.length; k++) {
    const v = s[k];
    if (v !== prev + 1) { out.push(start === prev ? `${start}` : `${start}-${prev}`); start = v; }
    prev = v;
  }
  return out.join(',');
}

/** True when stdout is a terminal, so progress can overwrite itself. Piped to a
 *  file or a CI log it must not, or every tick becomes another line of noise. */
export const isTTY = !!process.stdout.isTTY;

/** Overwrite-in-place on a terminal; a sparse line every ~10% otherwise. */
export function writeProgress(line, done, total) {
  if (isTTY) { process.stdout.write(line + '\r'); return; }
  const step = Math.max(1, Math.floor(total / 10));
  if (done === total || done % step === 0) process.stdout.write(line.trim() + '\n');
}

export function clearLine() { if (isTTY) process.stdout.write(' '.repeat(110) + '\r'); }

/** A progress line that overwrites itself, with rate + ETA. */
export function progressBar(done, total, startedAt, extra = '') {
  const el = (Date.now() - startedAt) / 1000;
  const rate = done / Math.max(el, 0.001);
  const pct = total ? (done / total) * 100 : 0;
  const width = 22;
  const filled = Math.round((pct / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `  ${c.cy(bar)} ${c.b(`${done}/${total}`)} ${pct.toFixed(1).padStart(5)}%  ` +
    `${rate.toFixed(2)} fps  ETA ${fmtDuration(rate > 0 ? (total - done) / rate : 0)}${extra}   `;
}

/**
 * Parse a frame selection: indices, ranges, or timestamps.
 *
 * Exists so that "I can see it at 0:48" is directly actionable. Detectors are
 * heuristics and will occasionally miss something a person can see instantly;
 * having to delete PNGs by hand to act on that is a bad answer.
 *
 *   "1440"              one frame
 *   "1438-1442"         a range of frames
 *   "48s"               the frame at t=48s
 *   "47.5s-48.5s"       every frame in that time range
 *   "1440,47.5s-48s"    any combination
 *
 * @returns {number[]} sorted, de-duplicated, clamped to [0, total)
 */
export function parseFrameSelection(spec, fps, total) {
  const out = new Set();
  const toFrame = (tok) => /s$/i.test(tok)
    ? Math.round(parseFloat(tok) * fps)
    : parseInt(tok, 10);

  for (const raw of String(spec || '').split(',')) {
    const token = raw.trim();
    if (!token) continue;
    // Split on a hyphen that separates two values, not one inside a number.
    const m = /^(\d*\.?\d+s?)\s*-\s*(\d*\.?\d+s?)$/i.exec(token);
    if (m) {
      const a = toFrame(m[1]), b = toFrame(m[2]);
      if (!isFinite(a) || !isFinite(b)) continue;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        if (i >= 0 && i < total) out.add(i);
      }
      continue;
    }
    const i = toFrame(token);
    if (isFinite(i) && i >= 0 && i < total) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}
