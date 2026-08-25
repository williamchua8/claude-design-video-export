// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------
//
// A Claude Design composition declares its sections up front:
//
//   window.OM_SCENES = '[{"name":"Silos","dur":5,"desc":"..."}, ...]'
//
// Each entry is a named slice of one continuous timeline, and its start is the
// running sum of the durations before it. That makes it possible to render one
// section without touching the rest -- useful when a 52-second piece has one
// scene you want to re-cut, and pointless to re-render the other 47 seconds of
// it. It is also what lets the tool show a human-readable menu instead of
// asking for timestamps.
//
// Note the "nat" field: it is the engine's authored-length anchor, stamped when
// a section is retimed on the host timeline. "dur" is the PLAYBACK length, which
// is what the exported video actually runs for, so "dur" is what we sum.

import { c, fmtDuration } from './util.js';

/** Read OM_SCENES out of a live page. Returns [] when the page has none. */
export async function readScenes(page) {
  return page.evaluate(() => {
    const raw = window.OM_SCENES;
    if (!raw) return [];
    try {
      const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }).catch(() => []);
}

/** Attach absolute start/end times to each scene entry. */
export function withTimes(scenes) {
  let t = 0;
  return scenes.map((s, i) => {
    const dur = Number(s.dur) > 0 ? Number(s.dur) : 0;
    const entry = {
      index: i,
      name: String(s.name || `Scene ${i + 1}`),
      desc: String(s.desc || ''),
      dur,
      start: t,
      end: t + dur,
    };
    t += dur;
    return entry;
  });
}

export const scenesTotal = (scenes) => withTimes(scenes).reduce((m, s) => Math.max(m, s.end), 0);

/**
 * Resolve a user selection into a { start, end } window.
 * Accepts scene names (case-insensitive, partial), 1-based indices, ranges
 * ("2-4"), and comma lists. Only contiguous selections make sense for a single
 * output file, so the window spans from the earliest to the latest match.
 */
export function resolveSelection(scenes, selection) {
  const list = withTimes(scenes);
  if (!selection || !String(selection).trim()) return null;

  const picked = new Set();
  for (const tokenRaw of String(selection).split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) {
      const a = parseInt(range[1], 10), b = parseInt(range[2], 10);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        if (i >= 1 && i <= list.length) picked.add(i - 1);
      }
      continue;
    }
    if (/^\d+$/.test(token)) {
      const i = parseInt(token, 10);
      if (i >= 1 && i <= list.length) picked.add(i - 1);
      continue;
    }
    const lower = token.toLowerCase();
    const exact = list.find((s) => s.name.toLowerCase() === lower);
    if (exact) { picked.add(exact.index); continue; }
    for (const s of list) if (s.name.toLowerCase().includes(lower)) picked.add(s.index);
  }

  if (!picked.size) return null;
  const idxs = [...picked].sort((a, b) => a - b);
  const first = list[idxs[0]], last = list[idxs[idxs.length - 1]];
  const gaps = idxs.length !== (idxs[idxs.length - 1] - idxs[0] + 1);
  return {
    start: first.start,
    end: last.end,
    names: idxs.map((i) => list[i].name),
    indices: idxs,
    contiguous: !gaps,
  };
}

export function printScenes(scenes, { fps = 30 } = {}) {
  const list = withTimes(scenes);
  if (!list.length) return;
  console.log('\n' + c.b('  Scenes in this composition'));
  for (const s of list) {
    console.log(`   ${c.b(String(s.index + 1).padStart(2))}) ${c.b(s.name.padEnd(12))} ` +
      c.dim(`${s.start.toFixed(1)}s – ${s.end.toFixed(1)}s  (${s.dur}s, ${Math.round(s.dur * fps)} frames)`));
    if (s.desc) console.log(c.dim(`       ${s.desc.slice(0, 88)}`));
  }
  console.log(c.dim(`   total ${fmtDuration(scenesTotal(scenes))}`));
}
