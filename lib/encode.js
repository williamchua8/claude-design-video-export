// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------
//
// Two things matter here beyond "make an mp4".
//
// COLOUR. PNG frames are FULL-range RGB; H.264 for delivery is LIMITED-range
// YUV. Convert without saying so and ffmpeg's default and the player's
// assumption can disagree by exactly one range expansion, giving you either
// milky blacks or crushed shadows. Both ends of the conversion are stated
// explicitly, and the file is then tagged to match.
//
// BIT BUDGET. A flat, dark motion-graphics frame with thin high-contrast text is
// the worst case for a fixed bitrate target: most of the frame is nearly free,
// so an average-bitrate encoder reports plenty of headroom while the few busy
// edge blocks starve. That is what reads as soft glyphs and colour fringing
// around text. CRF spends what each frame actually needs, so the default is CRF
// with no cap at all. A cap only appears in the 'delivery' profile, where a
// platform requires one.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { c, fmtBytes, fmtDuration } from './util.js';

/** Bundled ffmpeg first, so nothing has to be installed; fall back to PATH. */
export function ffmpegBin() {
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (!r.error && r.status === 0) return 'ffmpeg';
  return null;
}

export const QUALITY_PROFILES = {
  master: {
    label: 'Master (H.264, CRF 16)',
    note: 'best all-round: sharp, plays everywhere, sane size',
    ext: '.mp4',
  },
  delivery: {
    label: 'Delivery (H.264, CRF 18 + bitrate cap)',
    note: 'sized for YouTube / social upload specs',
    ext: '.mp4',
  },
  h265: {
    label: 'HEVC 10-bit (CRF 20)',
    note: 'smallest at equal quality; 10-bit kills gradient banding',
    ext: '.mp4',
  },
  prores: {
    label: 'ProRes 422 HQ',
    note: 'edit-ready intermediate for Premiere / Resolve / FCP. Very large files',
    ext: '.mov',
  },
};

/**
 * Video filter chain.
 * The scale filter is always present even when no resizing happens, because it
 * is what carries the explicit range/matrix conversion.
 */
export function buildFilter(cfg, srcW, srcH) {
  const parts = [];

  // Deband is OFF unless asked for. At the strengths people usually copy off the
  // internet (gradfun=20:30) it draws a soft rectangular halo around sharp UI
  // text and thin lines and visibly blurs their edges -- fixing banding the
  // composition may not have while creating a text-softness problem it does.
  if (cfg.deband) parts.push(cfg.deband);

  const opts = ['in_range=full', 'out_range=limited', 'out_color_matrix=bt709', 'sws_dither=ed'];
  if (srcW !== cfg.geom.outW || srcH !== cfg.geom.outH) {
    // lanczos + accurate_rnd is what makes supersampled captures resolve into a
    // genuinely sharper downscale rather than a soft one.
    opts.unshift(`w=${cfg.geom.outW}`, `h=${cfg.geom.outH}`, 'flags=lanczos+accurate_rnd');
  }
  parts.push('scale=' + opts.join(':'));

  // 4:2:0, not 4:4:4. High 4:4:4 Predictive sits outside the H.264 feature set
  // that QuickTime, Windows Media Foundation, VideoToolbox and most hardware
  // decoders support -- they refuse it or decode garbage blocks. ffmpeg's own
  // software decoder plays it perfectly, which is exactly why it can look fine
  // right up until a normal player opens it.
  if (cfg.quality === 'prores') parts.push('format=yuv422p10le');
  else if (cfg.quality === 'h265' || cfg.tenBit) parts.push('format=yuv420p10le');
  else parts.push('format=yuv420p');

  return parts.join(',');
}

export function encoderArgs(cfg) {
  const px = cfg.geom.outW * cfg.geom.outH * cfg.fps;
  switch (cfg.quality) {
    case 'prores':
      // profile 3 = 422 HQ. -vendor apl0 keeps FCP happy.
      return ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0',
              '-qscale:v', '9', '-bits_per_mb', '8000'];
    case 'h265':
      return ['-c:v', 'libx265', '-preset', cfg.preset, '-crf', String(cfg.crf ?? 20),
              '-tag:v', 'hvc1',
              '-x265-params', 'aq-mode=3:aq-strength=1.0:profile=main10'];
    case 'delivery': {
      // YouTube's recommended band, scaled from resolution*fps rather than guessed.
      const mbps = Math.max(8, Math.round((px * 0.20) / 1e6));
      return ['-c:v', 'libx264', '-preset', cfg.preset, '-crf', String(cfg.crf ?? 18),
              '-profile:v', cfg.tenBit ? 'high10' : 'high', '-level', '5.2',
              '-maxrate', `${mbps}M`, '-bufsize', `${mbps * 2}M`,
              '-x264-params', x264Params(cfg)];
    }
    default:
      return ['-c:v', 'libx264', '-preset', cfg.preset, '-crf', String(cfg.crf ?? 16),
              '-profile:v', cfg.tenBit ? 'high10' : 'high', '-level', '5.2',
              '-x264-params', x264Params(cfg)];
  }
}

function x264Params(cfg) {
  // aq-mode=3 (auto-variance with bias to dark) is the single most useful knob
  // for this content: it moves bits into large flat dark regions, which is where
  // gradient banding shows, without stealing them from text edges.
  const p = ['aq-mode=3', 'aq-strength=1.0', 'psy-rd=1.00,0.15', 'rc-lookahead=60', 'ref=4', 'bframes=3'];
  if (cfg.x264Params) p.push(cfg.x264Params);
  return p.join(':');
}

function colourTagArgs(cfg) {
  if (cfg.quality === 'prores') return ['-color_range', 'tv', '-colorspace', 'bt709'];
  return [
    '-color_range', 'tv',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
  ];
}

/**
 * A long-lived ffmpeg reading PNG frames from stdin, so encoding overlaps
 * capture instead of following it. On a 4K/60 project that removes the entire
 * encode pass from the wall clock -- it finishes seconds after the last frame is
 * captured rather than minutes later.
 */
export function createEncoder(cfg, { srcW, srcH, expectedFrames }) {
  const bin = ffmpegBin();
  if (!bin) {
    throw new Error('No ffmpeg available. Run `npm install` to fetch the bundled build.');
  }

  const vf = buildFilter(cfg, srcW, srcH);
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-stats',
    '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(cfg.fps), '-i', 'pipe:0',
  ];
  if (cfg.audioFile) args.push('-i', cfg.audioFile);

  args.push('-vf', vf, ...encoderArgs(cfg));
  args.push('-r', String(cfg.fps), '-fps_mode', 'cfr', '-sws_dither', 'ed');
  args.push(...colourTagArgs(cfg));

  if (cfg.audioFile) {
    args.push('-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '256k', '-shortest');
  } else {
    args.push('-an');
  }
  args.push('-movflags', '+faststart', '-threads', '0', cfg.outFile);

  const proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });

  let closed = false;
  const exited = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      closed = true;
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-3000)}`));
    });
  });
  // Never let an EPIPE from a dead ffmpeg take the whole process down.
  proc.stdin.on('error', () => {});

  let pushed = 0;
  return {
    args, vf, proc, expectedFrames,
    get pushed() { return pushed; },
    async push(buf) {
      if (closed) throw new Error(`ffmpeg exited early:\n${stderr.slice(-3000)}`);
      pushed++;
      if (!proc.stdin.write(buf)) {
        await new Promise((r) => proc.stdin.once('drain', r));
      }
    },
    async finish() {
      try { proc.stdin.end(); } catch {}
      await exited;
      return { outFile: cfg.outFile, size: fs.statSync(cfg.outFile).size, frames: pushed };
    },
    kill() { try { proc.kill('SIGKILL'); } catch {} },
  };
}

export function describeEncode(cfg, srcW, srcH) {
  const q = QUALITY_PROFILES[cfg.quality] || QUALITY_PROFILES.master;
  const lines = [];
  lines.push(`  source   : ${srcW}x${srcH} PNG frames`);
  lines.push(`  output   : ${cfg.geom.outW}x${cfg.geom.outH} @ ${cfg.fps} fps` +
    (srcW === cfg.geom.outW && srcH === cfg.geom.outH ? c.dim('  (no resampling)') : c.dim('  (lanczos downscale)')));
  lines.push(`  quality  : ${q.label}${cfg.tenBit && cfg.quality !== 'h265' ? ' · 10-bit' : ''}`);
  lines.push(`  length   : ~${fmtDuration(cfg.totalFrames / cfg.fps)}`);
  if (cfg.audioFile) lines.push(`  audio    : ${path.basename(cfg.audioFile)}`);
  return lines.join('\n');
}

/** Find a finished voiceover / music bed sitting next to the project. */
export function findAudio(rootDir) {
  const found = [];
  (function walk(dir, depth) {
    if (depth > 3) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!/node_modules|\.git|frames/i.test(e.name)) walk(path.join(dir, e.name), depth + 1); }
      else if (/\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(e.name)) found.push(path.join(dir, e.name));
    }
  })(rootDir, 0);
  if (!found.length) return null;
  const score = (fp) => {
    const n = path.basename(fp).toLowerCase();
    let s = 0;
    if (/voice[\s_-]?over|narration|soundtrack|final|mix|\bvo\b/.test(n)) s += 5;
    if (/audio|sound|music|track/.test(n)) s += 2;
    return s;
  };
  return found.sort((a, b) => score(b) - score(a))[0];
}
