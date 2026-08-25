// ---------------------------------------------------------------------------
// Render queue
// ---------------------------------------------------------------------------
//
// A .zip from Claude Code routinely holds several compositions. Rendering them
// one at a time means sitting at the keyboard between each one, answering the
// same three questions and remembering which you have already done -- and a 4K
// export is long enough that "come back in ten minutes" is the whole cost.
//
// So: pick the ones you want, walk away, come back to a folder of finished mp4s.
//
// Two properties matter more than the convenience.
//
//   The queue never stops on a failure. One composition that will not render is
//   not a reason to abandon the other three; it is recorded and the queue moves
//   on. The summary at the end says exactly which succeeded and which did not.
//
//   Every item renders into its OWN frame folder (see workspace.js) and holds
//   its own lock. That is what makes the queue safe: before frame folders were
//   keyed by composition, running four videos back to back through one workDir
//   meant each one inherited the previous one's frames.

import path from 'node:path';
import { c, fmtDuration } from './util.js';

/**
 * Resolve a selection over the bundle list. Accepts "all", 1-based numbers,
 * ranges, and path/name substrings, comma-separated -- the same grammar as
 * --scene, because there is no reason for the user to learn two.
 */
export function resolveQueue(bundles, selection) {
  const sel = String(selection == null ? '' : selection).trim();
  if (!sel || /^(all|\*)$/i.test(sel)) return bundles.slice();

  const picked = new Set();
  for (const raw of sel.split(',')) {
    const token = raw.trim();
    if (!token) continue;

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range) {
      const a = parseInt(range[1], 10), b = parseInt(range[2], 10);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
        if (i >= 1 && i <= bundles.length) picked.add(i - 1);
      }
      continue;
    }
    if (/^\d+$/.test(token)) {
      const i = parseInt(token, 10);
      if (i >= 1 && i <= bundles.length) picked.add(i - 1);
      continue;
    }
    const lower = token.replace(/\\/g, '/').toLowerCase();
    let hit = false;
    bundles.forEach((b, i) => {
      const rel = b.rel.toLowerCase();
      if (rel === lower || rel.endsWith('/' + lower) || path.basename(rel) === lower) {
        picked.add(i); hit = true;
      }
    });
    if (!hit) bundles.forEach((b, i) => { if (b.rel.toLowerCase().includes(lower)) picked.add(i); });
  }
  return [...picked].sort((a, b) => a - b).map((i) => bundles[i]);
}

export function printBundles(bundles) {
  console.log('\n' + c.b('  Compositions in this project'));
  bundles.forEach((b, i) => {
    const note = b.durationHint
      ? `${b.durationHint}s · ${b.scenes.length} scene(s): ` +
        b.scenes.map((x) => x.name).join(', ').slice(0, 44)
      : '';
    console.log(`   ${c.b(String(i + 1).padStart(2))}) ${b.rel}${note ? c.dim('   ' + note) : ''}`);
  });
}

/**
 * Render every queued item in turn.
 *
 * @param items    bundles to render, in order
 * @param runOne   async (bundle, i) => { ok, outFile?, reason? }
 */
export async function runQueue(items, runOne) {
  const results = [];
  const t0 = Date.now();

  for (let i = 0; i < items.length; i++) {
    const b = items[i];
    console.log('\n' + c.b('  ' + '='.repeat(64)));
    console.log(c.b(`  [${i + 1}/${items.length}] ${b.rel}`));
    console.log(c.b('  ' + '='.repeat(64)));

    const started = Date.now();
    let r;
    try {
      r = await runOne(b, i);
    } catch (e) {
      // A queue that dies on item 2 of 4 has wasted the user's evening, so
      // anything a single item can throw is caught and recorded here.
      r = { ok: false, reason: (e && e.message) || String(e) };
      console.log(c.r(`\n  ${b.rel} failed: ${r.reason}`));
    }
    results.push({ bundle: b, ...(r || { ok: false, reason: 'no result' }), seconds: (Date.now() - started) / 1000 });
  }

  summarise(results, (Date.now() - t0) / 1000);
  return results;
}

function summarise(results, seconds) {
  const ok = results.filter((r) => r.ok);
  console.log('\n' + c.b('  Queue finished') + c.dim(`  ${fmtDuration(seconds)} total`));
  for (const r of results) {
    const mark = r.ok ? c.g('  ok  ') : c.r(' fail ');
    const detail = r.ok
      ? path.basename(r.outFile || '')
      : (r.reason === 'locked' ? 'frame folder in use by another render' : r.reason || 'unknown');
    console.log(`  ${mark} ${r.bundle.rel.padEnd(34).slice(0, 34)} ` +
      c.dim(`${fmtDuration(r.seconds)}  ${detail}`));
  }
  console.log(ok.length === results.length
    ? c.g(`\n  All ${results.length} rendered.`)
    : c.y(`\n  ${ok.length}/${results.length} rendered. ` +
      'Re-run the queue to retry the rest — finished frames are reused, so it picks up where it stopped.'));
}
