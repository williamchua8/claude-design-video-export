// ---------------------------------------------------------------------------
// Pixel analysis
// ---------------------------------------------------------------------------
//
// Used by the doctor to turn "the glow looks square" into a number.
//
// A true radial glow's brightness depends only on distance from its centre, so
// the distance at which it fades out is the same in every direction. A glow that
// has been clipped to its element's rectangular layer bounds -- the headless
// shell bug, and the transform-scaled-layer bug -- is cut off at the box edge
// instead, so it reaches sqrt(2) times further along the diagonals than along
// the axes. Measuring that ratio separates the two cases without anyone having
// to squint at a screenshot:
//
//     ratio ~ 1.0   radial, correct
//     ratio ~ 1.4   clipped to a rectangle

import { spawnSync } from 'node:child_process';
import { ffmpegBin } from './encode.js';

/** Decode a PNG buffer to { width, height, data } rgb24, optionally downscaled. */
export function decodeToRgb(pngBuf, maxW = 960) {
  const bin = ffmpegBin();
  if (!bin) throw new Error('ffmpeg is required for pixel analysis.');
  // Ask ffmpeg for the size first so we know the raw buffer's stride.
  const probe = spawnSync(bin, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'png', '-i', 'pipe:0',
    '-vf', `scale='min(${maxW},iw)':-2`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { input: pngBuf, maxBuffer: 1 << 30 });
  if (probe.status !== 0) throw new Error('ffmpeg could not decode the frame: ' + probe.stderr);

  // Recover dimensions from the PNG header and apply the same scale rule.
  const srcW = pngBuf.readUInt32BE(16), srcH = pngBuf.readUInt32BE(20);
  const w = Math.min(maxW, srcW);
  const h = Math.round((srcH * (w / srcW)) / 2) * 2;
  const data = probe.stdout;
  if (data.length < w * h * 3) {
    // Rounding disagreed; derive height from the actual byte count instead.
    const realH = Math.floor(data.length / (w * 3));
    return { width: w, height: realH, data };
  }
  return { width: w, height: h, data };
}

const at = (img, x, y) => {
  const i = (y * img.width + x) * 3;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Candidate glow centres, brightest first.
 *
 * "Brightest saturated pixel" alone is not enough: a solid coloured card is
 * brighter than the glow beside it and would win every time. What distinguishes
 * a glow is not its peak but its FALLOFF -- it fades out over tens of pixels,
 * where a solid element drops to the background within one or two. So
 * candidates are scored and later filtered on softness, not just brightness.
 */
export function findGlowCandidates(img, { minSat = 25, count = 6 } = {}) {
  const step = Math.max(1, Math.floor(img.width / 200));
  const found = [];
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const [r, g, b] = at(img, x, y);
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      if (sat < minSat) continue;
      found.push({ x, y, score: luma(r, g, b) + sat * 0.5 });
    }
  }
  found.sort((a, b) => b.score - a.score);

  // Keep peaks that are far enough apart to be separate elements.
  const minDist = img.width * 0.08;
  const picked = [];
  for (const cand of found) {
    if (picked.every((p) => Math.hypot(p.x - cand.x, p.y - cand.y) > minDist)) picked.push(cand);
    if (picked.length >= count) break;
  }
  return picked;
}

/** Back-compat single-candidate helper. */
export function findGlowCenter(img, opts = {}) {
  return findGlowCandidates(img, opts)[0] || null;
}

/** Brightness above the local background, along a ray, sampled to `steps`. */
function rayProfile(img, cx, cy, dx, dy, maxR, steps = 64) {
  const out = [];
  for (let s = 0; s <= steps; s++) {
    const r = (s / steps) * maxR;
    const x = Math.round(cx + dx * r), y = Math.round(cy + dy * r);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) { out.push(null); continue; }
    const [rr, gg, bb] = at(img, x, y);
    out.push({ r, l: luma(rr, gg, bb) });
  }
  return out;
}

/** Distance at which the ray has fallen to `frac` of its peak-over-floor. */
function falloffRadius(profile, floor, peak, frac) {
  const threshold = floor + (peak - floor) * frac;
  for (const p of profile) {
    if (!p) return null;
    if (p.l <= threshold) return p.r;
  }
  return null;
}

/**
 * @returns { ratio, axisR, diagR, verdict } — ratio near 1 is radial,
 *          near 1.41 means the glow is clipped to a rectangle.
 *
 * `frac` deliberately sits low on the falloff curve. A clipped glow is only cut
 * off in its TAIL: near the centre it is still a perfectly ordinary radial
 * gradient, so measuring at 35% of peak shows almost no difference (1.13),
 * while measuring at 12% shows the full signature (1.37 against 1.00 for the
 * same glow unclipped). Verified in test/selftest.js against a fixture with one
 * clipped and one unclipped copy of an identical glow.
 */
export function radialAnisotropy(img, center, { maxR = null, frac = 0.12 } = {}) {
  const cx = center.x, cy = center.y;
  const R = maxR || Math.min(cx, cy, img.width - cx, img.height - cy) * 0.95;
  if (R < 12) return { ratio: null, verdict: 'glow too close to the frame edge to measure' };

  const k = Math.SQRT1_2;
  const axes = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const diags = [[k, k], [-k, k], [k, -k], [-k, -k]];

  const [pr, pg, pb] = at(img, cx, cy);
  const peak = luma(pr, pg, pb);
  // Floor = the dimmest sample on the longest rays, i.e. the background.
  let floor = 255;
  for (const [dx, dy] of [...axes, ...diags]) {
    const p = rayProfile(img, cx, cy, dx, dy, R);
    for (const s of p) if (s && s.l < floor) floor = s.l;
  }
  if (peak - floor < 12) return { ratio: null, verdict: 'no measurable glow at this point' };

  const measure = (dirs) => {
    const rs = dirs
      .map(([dx, dy]) => falloffRadius(rayProfile(img, cx, cy, dx, dy, R), floor, peak, frac))
      .filter((v) => v != null && v > 0);
    return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
  };

  const axisR = measure(axes);
  const diagR = measure(diags);
  if (!axisR || !diagR) return { ratio: null, verdict: 'falloff ran off the frame; inconclusive' };

  const ratio = diagR / axisR;
  let verdict;
  if (ratio < 1.12) verdict = 'radial (correct)';
  else if (ratio < 1.25) verdict = 'slightly boxy';
  else verdict = 'CLIPPED TO A RECTANGLE';
  return { ratio: +ratio.toFixed(3), axisR: +axisR.toFixed(1), diagR: +diagR.toFixed(1), peak: Math.round(peak), floor: Math.round(floor), verdict };
}

/**
 * How gradually the brightness falls off, as a fraction of the falloff radius.
 * A blurred glow transitions from 80% to 20% over a wide band; a solid element
 * with a hard edge does it almost instantly.
 */
export function edgeSoftness(img, center, { maxR = null } = {}) {
  const cx = center.x, cy = center.y;
  const R = maxR || Math.min(cx, cy, img.width - cx, img.height - cy) * 0.95;
  if (R < 12) return 0;
  const k = Math.SQRT1_2;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [k, k], [-k, k], [k, -k], [-k, -k]];

  const [pr, pg, pb] = at(img, cx, cy);
  const peak = luma(pr, pg, pb);
  let floor = 255;
  const profiles = dirs.map(([dx, dy]) => rayProfile(img, cx, cy, dx, dy, R));
  for (const p of profiles) for (const s of p) if (s && s.l < floor) floor = s.l;
  if (peak - floor < 12) return 0;

  const widths = [];
  for (const p of profiles) {
    const r80 = falloffRadius(p, floor, peak, 0.8);
    const r20 = falloffRadius(p, floor, peak, 0.2);
    if (r80 != null && r20 != null && r20 > 0) widths.push((r20 - r80) / r20);
  }
  return widths.length ? widths.reduce((a, b) => a + b, 0) / widths.length : 0;
}

/**
 * Analyse the most glow-like thing in the frame.
 * Returns the anisotropy result plus which candidate was chosen and why, so the
 * report can say "measured the blob at (x,y)" rather than asking for trust.
 */
/**
 * Slide a candidate onto the actual centre of its glow.
 *
 * A raw brightest-pixel pick can land anywhere on a broad plateau, and the
 * anisotropy measurement is only meaningful from the true centre -- measured
 * off-centre it reports whatever the frame edge does. Three rounds of a
 * brightness-weighted centroid converge reliably.
 */
export function refineCentre(img, cand, rounds = 3) {
  let cx = cand.x, cy = cand.y;
  const R = Math.max(10, Math.min(cx, cy, img.width - cx, img.height - cy) * 0.6);
  for (let n = 0; n < rounds; n++) {
    let sw = 0, sx = 0, sy = 0;
    const step = Math.max(1, Math.round(R / 24));
    // Weight by brightness above the window's own dimmest sample, so the
    // background contributes nothing.
    let floor = 255;
    for (let y = Math.max(0, cy - R); y < Math.min(img.height, cy + R); y += step)
      for (let x = Math.max(0, cx - R); x < Math.min(img.width, cx + R); x += step) {
        const [r, g, b] = at(img, x | 0, y | 0);
        const l = luma(r, g, b); if (l < floor) floor = l;
      }
    for (let y = Math.max(0, cy - R); y < Math.min(img.height, cy + R); y += step)
      for (let x = Math.max(0, cx - R); x < Math.min(img.width, cx + R); x += step) {
        const [r, g, b] = at(img, x | 0, y | 0);
        const wgt = Math.max(0, luma(r, g, b) - floor) ** 2;
        sw += wgt; sx += wgt * x; sy += wgt * y;
      }
    if (!sw) break;
    const nx = Math.round(sx / sw), ny = Math.round(sy / sw);
    if (nx === cx && ny === cy) break;
    cx = nx; cy = ny;
  }
  return { ...cand, x: cx, y: cy };
}

export function analyseGlow(img, { minSoftness = 0.25 } = {}) {
  const raw = findGlowCandidates(img);
  // Refine each onto its true centre, then collapse candidates that converged
  // onto the same glow so one glow is not measured three times.
  const candidates = [];
  for (const r of raw) {
    const ref = refineCentre(img, r);
    if (candidates.every((p) => Math.hypot(p.x - ref.x, p.y - ref.y) > img.width * 0.04)) {
      candidates.push(ref);
    }
  }
  const scored = [];
  for (const cand of candidates) {
    const soft = edgeSoftness(img, cand);
    const an = radialAnisotropy(img, cand);
    scored.push({ centre: cand, softness: +soft.toFixed(3), ...an });
  }
  const glows = scored.filter((s) => s.softness >= minSoftness && s.ratio != null);
  if (!glows.length) {
    return {
      ratio: null,
      verdict: candidates.length
        ? 'no soft-edged glow found in this frame (nothing with a gradual falloff)'
        : 'no coloured highlight found in this frame',
      candidates: scored,
    };
  }
  // Report the WORST glow in the frame, not the best. This is a diagnostic: if
  // one glow renders correctly and another is clipped to its box, the useful
  // answer is "you have a clipped glow", not "here is a glow that is fine".
  glows.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
  return { ...glows[0], glowCount: glows.length, candidates: scored };
}

/** Mean absolute per-pixel difference between two same-size PNGs, 0..255. */
export function frameDelta(pngA, pngB, maxW = 480) {
  const a = decodeToRgb(pngA, maxW), b = decodeToRgb(pngB, maxW);
  const n = Math.min(a.data.length, b.data.length);
  if (!n) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a.data[i] - b.data[i]);
  return +(sum / n).toFixed(4);
}
