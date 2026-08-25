#!/usr/bin/env node
/* ===========================================================================
 * Claude Design  ->  MP4
 * ---------------------------------------------------------------------------
 * Point it at a standalone .html, a project folder, or the .zip Claude Code
 * gives you. Nothing here is specific to one project: composition size,
 * duration and frame count are all read off the bundle at run time.
 *
 *   node render.js                      pick it up from the current folder
 *   node render.js --input scene.zip
 *   node render.js --input scene.html --action doctor
 * ========================================================================= */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { resolveInput, autoDetect, startServer } from './lib/input.js';
import { withTimes, resolveSelection, printScenes, scenesTotal } from './lib/scenes.js';
import { probeProject } from './lib/probe.js';
import { computeGeometry } from './lib/capture.js';
import { render } from './lib/pipeline.js';
import { resolveQueue, printBundles, runQueue } from './lib/queue.js';
import { projectKey, bundleNames, fileHash, framesDir } from './lib/workspace.js';
import { QUALITY_PROFILES, ffmpegBin, findAudio } from './lib/encode.js';
import { runDoctor } from './lib/doctor.js';
import { ANGLE_BACKENDS } from './lib/browser.js';
import { c, fmtDuration, clamp, even, parseFrameSelection } from './lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// "Resolution" means target HEIGHT. Width follows the composition's own aspect
// ratio, so a 16:9 piece gives 3840x2160 and a square piece gives 2160x2160 --
// nothing is ever stretched or letterboxed.
const RESOLUTIONS = [
  { key: '4k',    label: '4K / UHD', height: 2160, note: 'sharpest, slowest' },
  { key: '2k',    label: '2K / QHD', height: 1440, note: 'good middle ground' },
  { key: '1080p', label: '1080p HD', height: 1080, note: 'fastest' },
  { key: 'native', label: 'Native',  height: 0,    note: "the composition's own size" },
];
const FPS_CHOICES = [60, 50, 30, 25, 24];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const num = (f, d) => { const v = val(f, null); return v == null ? d : (parseFloat(v) || d); };

const OPT = {
  input:     val('--input', null),
  action:    val('--action', null),        // render | fill | export | frames | doctor | preview
  res:       val('--res', null),
  fps:       val('--fps', null) ? parseInt(val('--fps'), 10) : null,
  duration:  num('--duration', null),
  out:       val('--out', null),
  jobs:      val('--jobs', null) ? parseInt(val('--jobs'), 10) : null,
  ss:        clamp(parseInt(val('--ss', '1'), 10) || 1, 1, 4),
  scaleMode: val('--scale-mode', 'dpr'),   // dpr | layout
  timeMode:  val('--time', 'absolute'),    // absolute | replay | off
  freezeTimers: has('--freeze-timers'),
  raster:    has('--software') ? 'software' : val('--raster', 'gpu'),
  channel:   val('--channel', null),
  angle:     val('--angle', null),         // default|d3d11|d3d9|gl|vulkan|swiftshader
  entry:     val('--entry', null),         // which bundle inside a zip/folder
  queue:     val('--queue', null),         // render several bundles back to back
  all:       has('--all'),                 // shorthand for --queue all
  listEntries: has('--list-entries'),
  scene:     val('--scene', null),         // "IPAM" | "3" | "2-4" | "ipam,close"
  listScenes: has('--list-scenes'),
  noSweep:   has('--no-sweep'),
  sweepMaxRun: Math.max(1, parseInt(val('--sweep-max-run', '4'), 10) || 4),
  sweepSensitivity: val('--sweep-sensitivity', 'normal'),
  noOutliers: has('--no-transition-sweep'),
  redo:      val('--redo', null),
  paintDeterminism: has('--paint-determinism'),
  quality:   val('--quality', 'master'),
  preset:    val('--preset', 'slow'),
  crf:       val('--crf', null) ? parseInt(val('--crf'), 10) : null,
  tenBit:    has('--10bit'),
  deband:    has('--deband') ? val('--deband', 'gradfun=3:16') : null,
  x264:      val('--x264-params', null),
  audio:     val('--audio', null),
  noAudio:   has('--no-audio'),
  settle:    Math.max(0, parseInt(val('--settle', '0'), 10) || 0),
  warmMs:    Math.max(0, parseInt(val('--warm', '250'), 10) || 250),
  warmStride: num('--warm-stride', 1 / 15),
  timeout:   Math.max(60000, parseInt(val('--timeout', '600000'), 10) || 600000),
  verify:    has('--verify'),
  fresh:     has('--fresh'),
  reap:      has('--reap'),
  noConcurrent: has('--no-concurrent'),
  yes:       has('--yes') || has('-y'),
  help:      has('--help') || has('-h'),
};

const HELP = `
${c.b('Claude Design -> MP4')}

  node render.js [--input <file|folder|zip>] [options]

${c.b('Input')}
  --input <path>        .html, a project folder, or a .zip from Claude Code.
                        Omit it and the current folder is searched.

${c.b('Output')}
  --res 4k|2k|1080p|native      target height (default 4k)
  --fps 60|50|30|25|24          default 60
  --duration <sec>              only needed for pages with no timeline API
  --out <file.mp4>              default: alongside the project
  --quality master|delivery|h265|prores
  --crf <n>  --preset <x264 preset>  --10bit

${c.b('Choosing what to render')}
  --entry <rel path>        which bundle inside a folder/zip (a Claude Code zip
                            often holds several videos). Omit to be asked.
  --list-entries            print the compositions in the project and exit
  --all                     queue and render EVERY composition in the project
  --queue <sel>             queue some of them, then render each in turn.
                            Same grammar as --scene:
                              --queue all       --queue 1,3
                              --queue 2-4       --queue "intro,outro"
                            Each one gets its own frame folder and its own
                            output file; a failure is recorded and the queue
                            carries on.
  --list-scenes             print the composition's scenes and exit
  --scene <sel>             render only part of the timeline. Accepts a scene
                            name, a 1-based number, a range or a list:
                              --scene IPAM      --scene 3
                              --scene 2-4       --scene "ipam,close"

${c.b('Quality / correctness')}
  --scale-mode dpr|layout   dpr (default) raises device pixel ratio so the stage
                            never scales; layout scales the stage with a CSS
                            transform. Identical when the composition is authored
                            at the export resolution.
  --time absolute|replay|off
                            absolute (default) pins every CSS/rAF animation to
                            the seek time. replay also steps through the
                            timeline so mid-scene transitions get the right
                            birth time. off disables the virtual clock.
  --ss 1..4                 supersample, then lanczos-downscale on encode
  --raster gpu|software     (--software is shorthand)
  --freeze-timers           also virtualise setTimeout/setInterval
  --verify                  re-render every frame and compare (slow)
  --angle <backend>         graphics backend: ${ANGLE_BACKENDS.join(' | ')}.
                            If a glow renders as a rectangle on your machine but
                            looks right elsewhere, try --angle swiftshader: it
                            bypasses the GPU driver entirely.
  --no-sweep                skip the paint-dropout check (on by default; it is
                            what stops sections of the UI blinking)
  --sweep-max-run <n>       longest dropout to look for, in frames (default 4).
                            Real ones observed so far are 1-2 frames long.
  --sweep-sensitivity low|normal|high
                            how eagerly to suspect a frame DURING A TRANSITION,
                            where a dropout cannot be identified as cleanly as
                            during a hold. Higher flags more candidates; each
                            one costs a re-render, and anything the composition
                            meant to do reproduces and is kept. Try "high" if a
                            blink survives a normal sweep. Default normal
                            (~1% of frames re-rendered on real footage).
  --no-transition-sweep     only look for dropouts during holds (the original,
                            very specific test) and skip the transition pass
  --redo <sel>              re-render these frames whatever the detectors think,
                            then re-encode. For when you can SEE the bad frame:
                              --redo 1440          one frame
                              --redo 1438-1442     a range
                              --redo 48s           by timestamp
                              --redo 47.9s-48.1s   a time range
  --paint-determinism       extra compositor flags that force paint to finish
                            before capture. Off by default: they can deadlock
                            the screenshot call, and the dropout sweep already
                            covers what they were meant to prevent.

${c.b('Speed')}
  --jobs <n>                parallel workers
  --no-concurrent           encode after capture instead of during
  --reap                    delete each frame once encoded (saves disk)

${c.b('Actions')}
  --action render           render everything, then export   (default)
  --action fill             render only missing frames, then export
  --action export           encode from the frames already on disk
  --action frames           capture frames, do not encode
  --action doctor           diagnose quality problems (start here)
  --action preview          short test clip to check settings

  -y, --yes                 skip prompts
`;

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

let rl = null;
// True once stdin has ended. Piped or redirected input delivers everything in
// one chunk, so readline reaches EOF after the first question and every prompt
// after it would throw ERR_USE_AFTER_CLOSE. Rather than crash halfway through a
// menu, prompts from that point on answer with their default and the menus quit.
let stdinDone = false;
const openPrompt = () => {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('close', () => { stdinDone = true; });
  }
  return rl;
};
const closePrompt = () => { if (rl) { rl.close(); rl = null; } };
const ask = (q) => (stdinDone
  ? Promise.resolve('')
  : new Promise((r) => openPrompt().question(q, (a) => r(a.trim()))));

async function choose(title, items, defaultIdx = 0) {
  console.log('\n' + c.b(title));
  items.forEach((it, i) => {
    const mark = i === defaultIdx ? c.cy('>') : ' ';
    console.log(`  ${mark} ${c.b(String(i + 1))}) ${it.label}${it.note ? c.dim('   ' + it.note) : ''}`);
  });
  for (;;) {
    const a = await ask(`\n  Choose 1-${items.length} ${c.dim(`[Enter = ${defaultIdx + 1}]`)}: `);
    if (a === '') return defaultIdx;
    if (stdinDone) return defaultIdx;
    const n = parseInt(a, 10);
    if (n >= 1 && n <= items.length) return n - 1;
    console.log(c.r('  Please enter a number from the list.'));
  }
}

async function confirm(q, def = true) {
  if (OPT.yes) return def;
  const a = await ask(`  ${q} ${c.dim(def ? '[Y/n]' : '[y/N]')}: `);
  return a === '' ? def : /^y/i.test(a);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function autoJobs(resKey) {
  const cores = os.cpus().length;
  const gb = os.totalmem() / 1e9;
  return Math.max(1, Math.min(
    Math.floor(cores / 2),
    Math.floor((gb - 2) / 1.6),
    resKey === '4k' ? 4 : 6,
  ));
}

function makeConfig(session, resKey, fps, overrides = {}) {
  const { project, url, workDir } = session;
  const res = RESOLUTIONS.find((r) => r.key === resKey) || RESOLUTIONS[0];
  const targetHeight = res.height || project.height;

  const geom = computeGeometry(project, {
    targetHeight,
    ss: overrides.ss ?? OPT.ss,
    scaleMode: overrides.scaleMode ?? OPT.scaleMode,
  });

  // A scene selection narrows the render to one slice of the timeline. Frame i
  // of the output maps to timeOffset + i/fps on the composition's own clock.
  const window = overrides.window || null;
  const timeOffset = window ? window.start : 0;
  const duration = window ? (window.end - window.start) : project.duration;
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const quality = overrides.quality ?? OPT.quality;
  const ext = (QUALITY_PROFILES[quality] || QUALITY_PROFILES.master).ext;

  const sceneTag = window && window.names && window.names.length
    ? '_' + window.names.join('-').replace(/[^\w-]+/g, '') : '';
  const outFile = OPT.out
    ? path.resolve(OPT.out)
    : path.join(workDir, `${session.name}${sceneTag}_${geom.outW}x${geom.outH}_${fps}fps${ext}`);

  let audioFile = null;
  if (!OPT.noAudio) {
    audioFile = OPT.audio ? path.resolve(OPT.audio) : findAudio(session.rootDir);
    if (audioFile && !fs.existsSync(audioFile)) audioFile = null;
  }

  return {
    input: url, project, adapter: project.adapter,
    workDir, resKey, fps, totalFrames, geom,
    // Frame-folder identity. Without these every composition in a project
    // would share one folder and overwrite the others' frames.
    projectId: session.projectId,
    entryRel: session.entryRel,
    entryHash: session.entryHash,
    bundleCount: session.bundleCount || 1,
    timeOffset, window,
    angle: OPT.angle,
    paintDeterminism: OPT.paintDeterminism,
    timeMode: overrides.timeMode ?? OPT.timeMode,
    freezeTimers: OPT.freezeTimers,
    seed: 0x2f6e2b1,
    raster: overrides.raster ?? OPT.raster,
    channel: OPT.channel,
    jobs: overrides.jobs ?? OPT.jobs ?? autoJobs(resKey),
    sweepMaxRun: OPT.sweepMaxRun,
    sweepSensitivity: OPT.sweepSensitivity,
    sweepOutliers: !OPT.noOutliers,
    redo: OPT.redo ? parseFrameSelection(OPT.redo, fps, totalFrames) : null,
    quality, preset: OPT.preset, crf: OPT.crf, tenBit: OPT.tenBit,
    deband: OPT.deband, x264Params: OPT.x264,
    audioFile,
    sceneTag,
    settleMs: OPT.settle, warmMs: OPT.warmMs, warmStride: OPT.warmStride,
    chunkFrames: 0,
    timeout: OPT.timeout, verify: OPT.verify, fresh: OPT.fresh,
    outFile,
  };
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function banner(session, cfg) {
  const p = session.project;
  console.log('\n' + c.b('  Claude Design  ->  MP4'));
  console.log(c.dim('  ' + '-'.repeat(60)));
  console.log(`  project   ${c.b(session.name)}  ${c.dim(path.basename(session.entryFile))}`);
  console.log(`  detected  ${p.adapterLabel}`);
  console.log(`  composed  ${p.width}x${p.height}  ${c.dim(`${p.duration}s`)}`);
  console.log(`  browser   ${c.dim(p.browserInfo.label)}`);
  if (p.browserInfo.shellWarning) console.log(c.r(`  ! ${p.browserInfo.shellWarning}`));
  if (p.gpu) console.log(`  graphics  ${c.dim(String(p.gpu).slice(0, 52))}`);
  if (cfg) {
    console.log(`  target    ${c.b(`${cfg.geom.outW}x${cfg.geom.outH} @ ${cfg.fps} fps`)} ` +
      c.dim(`${cfg.totalFrames} frames · ${QUALITY_PROFILES[cfg.quality].label}`));
    console.log(`  render    ${c.dim(`${cfg.geom.scaleMode} (dpr ${cfg.geom.dsf}` +
      `${cfg.geom.ss > 1 ? `, ss ${cfg.geom.ss}x` : ''}) · ${cfg.raster} raster · ` +
      `time=${cfg.timeMode} · ${cfg.jobs} worker(s)`)}`);
    if (cfg.window) {
      console.log(`  scenes    ${c.b(cfg.window.names.join(' + '))} ` +
        c.dim(`${cfg.window.start.toFixed(1)}s – ${cfg.window.end.toFixed(1)}s`));
    } else if (p.scenes && p.scenes.length) {
      console.log(`  scenes    ${c.dim(`whole timeline (${p.scenes.length}: ` +
        `${p.scenes.map((x) => x.name).join(', ').slice(0, 44)})`)}`);
    }
    if (cfg.angle) console.log(`  graphics  ${c.dim('ANGLE backend: ' + cfg.angle)}`);
    // Worth showing: it is per-composition, so two videos in one project can
    // never overwrite each other's work, and you can see exactly where it went.
    console.log(`  frames    ${c.dim(path.relative(cfg.workDir, framesDir(cfg)))}`);
    if (cfg.audioFile) console.log(`  audio     ${c.dim(path.basename(cfg.audioFile))}`);
  }
  console.log(c.dim('  ' + '-'.repeat(60)));
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

async function pickOutput(project) {
  const rIdx = await choose('Resolution', RESOLUTIONS.map((r) => {
    const h = r.height || project.height;
    return {
      label: `${r.label.padEnd(9)} ${even(project.width * (h / project.height))} x ${even(h)}`,
      note: r.note,
    };
  }), 0);
  const fIdx = await choose('Frame rate', FPS_CHOICES.map((f) => ({
    label: `${f} fps`.padEnd(9) + c.dim(`${Math.round(project.duration * f)} frames`),
    note: f === 60 ? 'smoothest' : f === 30 ? 'smallest file' : '',
  })), 0);
  return { resKey: RESOLUTIONS[rIdx].key, fps: FPS_CHOICES[fIdx] };
}

async function advancedMenu(cfg) {
  for (;;) {
    console.log('\n' + c.b('Advanced'));
    console.log(`   1) Quality profile   ${c.b(QUALITY_PROFILES[cfg.quality].label)}`);
    console.log(`   2) Scale mode        ${c.b(cfg.geom.scaleMode)} ${c.dim('(dpr = stage never scales)')}`);
    console.log(`   3) Time handling     ${c.b(cfg.timeMode)} ${c.dim('(absolute fixes stutter)')}`);
    console.log(`   4) Supersampling     ${c.b(cfg.geom.ss > 1 ? `${cfg.geom.ss}x` : 'off')}`);
    console.log(`   5) Raster            ${c.b(cfg.raster)}`);
    console.log(`   6) Workers           ${c.b(String(cfg.jobs))}`);
    console.log(`   7) Back`);
    const a = await ask('\n  Choose 1-7: ');
    if (a === '' && stdinDone) return;

    if (a === '1') {
      const keys = Object.keys(QUALITY_PROFILES);
      const i = await choose('Quality profile',
        keys.map((k) => ({ label: QUALITY_PROFILES[k].label, note: QUALITY_PROFILES[k].note })),
        Math.max(0, keys.indexOf(cfg.quality)));
      cfg.quality = keys[i];
      cfg.outFile = cfg.outFile.replace(/\.(mp4|mov)$/i, QUALITY_PROFILES[cfg.quality].ext);
    } else if (a === '2') {
      const i = await choose('Scale mode', [
        { label: 'dpr',    note: 'raise device pixel ratio; the stage renders at scale 1.0' },
        { label: 'layout', note: 'scale the stage with a CSS transform (legacy behaviour)' },
      ], cfg.geom.scaleMode === 'dpr' ? 0 : 1);
      cfg.geom = computeGeometry(cfg.project, {
        targetHeight: cfg.geom.outH, ss: cfg.geom.ss, scaleMode: i === 0 ? 'dpr' : 'layout',
      });
    } else if (a === '3') {
      const modes = ['absolute', 'replay', 'off'];
      const i = await choose('Time handling', [
        { label: 'absolute', note: 'pin every CSS/rAF animation to the seek time (recommended)' },
        { label: 'replay',   note: 'also step the timeline so mid-scene transitions start correctly' },
        { label: 'off',      note: 'let the page use the real clock (reproduces the stutter)' },
      ], Math.max(0, modes.indexOf(cfg.timeMode)));
      cfg.timeMode = modes[i];
    } else if (a === '4') {
      const i = await choose('Supersampling', [
        { label: '1x (off)', note: 'capture exactly at the target resolution' },
        { label: '2x',       note: 'sharpens scaled-up elements; ~4x slower capture' },
        { label: '3x',       note: 'rarely needed' },
      ], clamp(cfg.geom.ss - 1, 0, 2));
      cfg.geom = computeGeometry(cfg.project, {
        targetHeight: cfg.geom.outH, ss: i + 1, scaleMode: cfg.geom.scaleMode,
      });
    } else if (a === '5') {
      const i = await choose('Raster', [
        { label: 'gpu',      note: 'normal compositing path; correct large-blur rendering' },
        { label: 'software', note: 'steadier on very layer-heavy scenes, but boxier blurs' },
      ], cfg.raster === 'gpu' ? 0 : 1);
      cfg.raster = i === 0 ? 'gpu' : 'software';
    } else if (a === '6') {
      const v = await ask(`  Workers 1-8 ${c.dim(`[Enter = ${cfg.jobs}]`)}: `);
      const n = v === '' ? cfg.jobs : parseInt(v, 10);
      if (n >= 1 && n <= 8) cfg.jobs = n; else console.log(c.r('  Ignored.'));
    } else return;
  }
}

async function mainMenu(session, initialWindow = null, proj = null) {
  let cfg = null;
  let window = initialWindow;
  const multi = !!(proj && proj.bundles && proj.bundles.length > 1);
  const ensureCfg = async () => {
    if (cfg) return cfg;
    const pick = await pickOutput(session.project);
    cfg = makeConfig(session, pick.resKey, pick.fps, { window });
    return cfg;
  };

  for (;;) {
    banner(session, cfg);
    console.log('');
    console.log(`   ${c.b('1')}) Render video            ${c.dim('render all frames, then export')}`);
    console.log(`   ${c.b('2')}) Fill gaps and export    ${c.dim('re-render only missing frames')}`);
    console.log(`   ${c.b('3')}) Export from frames      ${c.dim('use the frames already on disk')}`);
    console.log(`   ${c.b('4')}) ${c.cy('Diagnose quality')}        ${c.dim('stutter / soft text / boxy glow — start here')}`);
    console.log(`   ${c.b('5')}) Quick preview           ${c.dim('2s test clip to check settings fast')}`);
    console.log(`   ${c.b('6')}) Resolution / frame rate`);
    console.log(`   ${c.b('7')}) Choose scenes          ${c.dim(
      window ? `currently: ${window.names.join(' + ')}` : 'currently: whole timeline')}`);
    console.log(`   ${c.b('8')}) Advanced settings`);
    if (multi) {
      console.log(`   ${c.b('9')}) ${c.cy('Queue several videos')}    ${c.dim(
        `render more than one of this project's ${proj.bundles.length} compositions`)}`);
    }
    console.log(`   ${c.b('0')}) Quit`);

    const a = await ask(`\n  Choose 1-${multi ? '9' : '8'} (0 to quit): `);
    if (a === '0' || /^q/i.test(a) || (a === '' && stdinDone)) return;

    if (a === '9' && multi) { await queueMenu(proj, session); continue; }

    if (a === '6') {
      const p = await pickOutput(session.project);
      cfg = makeConfig(session, p.resKey, p.fps, { window });
      continue;
    }

    if (a === '7') {
      const list = session.project.scenes || [];
      if (!list.length) { console.log(c.y('\n  This composition does not declare scenes.')); continue; }
      printScenes(list, { fps: cfg ? cfg.fps : 60 });
      const v = await ask('\n  Scenes to render — name, number, range, or blank for all: ');
      window = v.trim() ? resolveSelection(list, v) : null;
      if (v.trim() && !window) console.log(c.r('  Nothing matched; keeping the previous selection.'));
      else console.log(c.dim(window ? `  Selected ${window.names.join(' + ')}` : '  Whole timeline.'));
      // The output size/length changed, so the config has to be rebuilt.
      cfg = cfg ? makeConfig(session, cfg.resKey, cfg.fps, { window }) : null;
      continue;
    }
    if (a === '8') { await advancedMenu(await ensureCfg()); continue; }

    if (a === '4') { await runDoctor(session, await ensureCfg()); continue; }

    if (a === '5') {
      const base = await ensureCfg();
      const seconds = parseFloat(await ask(`  Preview length in seconds ${c.dim('[Enter = 2]')}: `) || '2') || 2;
      await renderPreview(session, base, seconds);
      continue;
    }

    if (a === '1' || a === '2' || a === '3') {
      const k = await ensureCfg();
      const action = a === '1' ? 'render' : a === '2' ? 'fill' : 'export';
      if (action === 'render' && !OPT.fresh) {
        // "Render video" means all frames; existing complete ones are reused,
        // which is the same thing but faster. --fresh forces a redraw.
      }
      await run(k, action);
      continue;
    }
    console.log(c.r(`  Please choose 1-${multi ? '9' : '8'}, or 0 to quit.`));
  }
}

/** Pick some of the project's compositions and render them back to back. */
async function queueMenu(proj, session) {
  printBundles(proj.bundles);
  console.log(c.dim('\n  Each one renders into its own frame folder and its own file,'));
  console.log(c.dim('  so nothing you have already rendered is touched.'));
  const v = await ask('\n  Queue which? number, range, name, or blank for all: ');
  const items = resolveQueue(proj.bundles, v.trim() || 'all');
  if (!items.length) { console.log(c.r('  Nothing matched.')); return; }

  // The resolution menu only needs a composition's shape to show sizes, and
  // probing every queued bundle just to draw that menu would cost a browser
  // launch each. The one already open is representative enough.
  const pick = await pickOutput(session.project);
  console.log(c.dim(`\n  Queued ${items.length}:`));
  items.forEach((b, i) => console.log(c.dim(`    ${i + 1}. ${b.rel}`)));
  if (!(await confirm(`\n  Render all ${items.length} at ${pick.resKey} / ${pick.fps} fps?`, true))) return;

  await runQueue(items, async (b) => {
    const s2 = await openBundle(proj, b);
    const cfg = makeConfig(s2, pick.resKey, pick.fps, {});
    banner(s2, cfg);
    const res = await run(cfg, 'render');
    return { ...res, outFile: cfg.outFile };
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const ACTIONS = ['render', 'fill', 'export', 'frames', 'doctor', 'preview'];

async function run(cfg, action) {
  // An unrecognised action must never fall through to "render everything at 4K":
  // a typo should not silently start an hour of work.
  if (!ACTIONS.includes(action)) {
    throw new Error(`Unknown --action "${action}". Valid: ${ACTIONS.join(', ')}`);
  }
  const t0 = Date.now();
  let res;
  const sweep = !OPT.noSweep;
  if (action === 'frames')      res = await render(cfg, { encode: false, sweep });
  else if (action === 'export') res = await render(cfg, { encode: true, concurrent: false, sweep: false });
  else res = await render(cfg, {
    encode: true,
    concurrent: !OPT.noConcurrent,
    reap: OPT.reap,
    sweep,
  });
  if (res.ok) console.log(c.dim(`\n  Total time ${fmtDuration((Date.now() - t0) / 1000)}`));
  return res;
}

/** A short clip from the middle of the timeline: the fastest way to check
 *  settings before committing to a full render. */
async function renderPreview(session, base, seconds) {
  const count = Math.max(1, Math.round(seconds * base.fps));
  const startT = Math.max(0, (session.project.duration - seconds) / 2);
  const cfg = {
    ...base,
    totalFrames: count,
    timeOffset: startT,
    workDir: path.join(base.workDir, '.cdv-preview'),
    outFile: base.outFile.replace(/(\.\w+)$/, '_preview$1'),
  };
  fs.mkdirSync(cfg.workDir, { recursive: true });
  console.log(c.dim(`\n  Preview: ${count} frames starting at t=${startT.toFixed(2)}s`));
  return render(cfg, { encode: true, concurrent: true, reap: true, sweep: false });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Open the project once: unpack it if it is a zip, list its compositions, and
 * put a static server in front of the whole tree.
 *
 * Deliberately does NOT probe a bundle. Probing costs a browser launch, and the
 * queue needs to do it once per composition rather than once per run, so the
 * two steps are separate: openProject() is the part that happens once.
 */
async function openProject() {
  let inputPath = OPT.input;

  if (!inputPath) {
    const candidates = autoDetect(process.cwd());
    if (!candidates.length) {
      throw new Error('No .html or .zip found in this folder.\n' +
        '  Pass one explicitly:  node render.js --input <file|folder|zip>');
    }
    if (candidates.length === 1 || OPT.yes) {
      inputPath = candidates[0].fp;
      console.log(c.dim(`  Using ${path.relative(process.cwd(), inputPath) || inputPath}`));
    } else {
      const i = await choose('Which project?', candidates.slice(0, 9).map((x) => ({
        label: path.relative(process.cwd(), x.fp) || x.fp,
        note: x.kind === 'zip' ? 'zip' : '',
      })), 0);
      inputPath = candidates[i].fp;
    }
  }

  const resolved = resolveInput(inputPath);
  const all = resolved.bundles || [];
  const bundles = (all.filter((b) => b.looksLikeBundle).length ? all.filter((b) => b.looksLikeBundle) : all);
  // Every composition gets its own name up front, computed against the others
  // so no two can end up writing the same mp4.
  bundleNames(bundles).forEach((n, i) => { bundles[i].name = n; });
  const server = await startServer(resolved.rootDir);

  // Zip projects live in a temp dir that disappears at exit, so frames and
  // videos go next to the zip instead.
  const workDir = resolved.fromZip
    ? path.dirname(path.resolve(inputPath))
    : resolved.rootDir;
  const baseName = resolved.fromZip
    ? path.basename(inputPath).replace(/\.zip$/i, '')
    : path.basename(resolved.rootDir);

  return {
    inputPath, rootDir: resolved.rootDir, fromZip: resolved.fromZip,
    all, bundles,
    defaultEntry: resolved.entryFile,
    workDir, baseName: baseName || 'output',
    server,
    cleanup: async () => { await server.close(); resolved.cleanup(); },
  };
}

/** Resolve --entry (or a menu choice) to one bundle in the project. */
async function pickBundle(proj) {
  if (OPT.entry) {
    const want = OPT.entry.replace(/\\/g, '/').toLowerCase();
    const hit = proj.all.find(
      (b) => b.rel.toLowerCase() === want || b.rel.toLowerCase().endsWith('/' + want) ||
             path.basename(b.rel).toLowerCase() === want);
    if (!hit) {
      throw new Error(`No bundle matching --entry "${OPT.entry}".\n  Available:\n   - ` +
        proj.all.map((b) => b.rel).join('\n   - '));
    }
    return hit;
  }
  if (proj.bundles.length > 1 && !OPT.yes) {
    console.log(c.dim(`\n  This project contains ${proj.bundles.length} separate compositions.`));
    console.log(c.dim('  (to render all of them in one go, re-run with --all)'));
    const i = await choose('Which one do you want to render?', proj.bundles.slice(0, 9).map((b) => ({
      label: b.rel,
      note: b.durationHint
        ? `${b.durationHint}s · ${b.scenes.length} scene(s): ${b.scenes.map((x) => x.name).join(', ').slice(0, 46)}`
        : '',
    })), 0);
    return proj.bundles[i];
  }
  return proj.bundles.find((b) => b.fp === proj.defaultEntry) || proj.bundles[0] ||
    { fp: proj.defaultEntry, rel: path.basename(proj.defaultEntry), name: null };
}

/**
 * Probe one composition and build the session the rest of the tool works with.
 * Called once per queued item, so everything here has to be per-bundle.
 */
async function openBundle(proj, bundle) {
  const entryFile = bundle.fp;
  const rel = path.relative(proj.rootDir, entryFile).split(path.sep).join('/');
  // ?__render=1 is what the Stage starter looks for; harmless for other bundles.
  const url = `${proj.server.origin}/${encodeURI(rel)}?__render=1`;

  console.log(c.dim('\n  Reading the bundle...'));
  const probe = await probeProject(url, {
    raster: OPT.raster, channel: OPT.channel, angle: OPT.angle, timeout: OPT.timeout,
  });

  const project = {
    ...probe,
    adapterLabel: {
      om: 'Claude Design bundle (animations-v3)',
      stage: 'Stage starter (window.__seek)',
      clock: 'Plain page — virtual clock only',
    }[probe.adapter],
  };

  if (!(project.width > 0) || !(project.height > 0)) {
    project.width = project.width || 1920;
    project.height = project.height || 1080;
  }
  if (!(project.duration > 0)) {
    if (OPT.duration) project.duration = OPT.duration;
    else if (OPT.yes) project.duration = 10;
    else {
      console.log(c.y(`\n  This page does not report a duration (${project.adapterLabel}).`));
      const v = await ask('  How many seconds should the video be? [Enter = 10]: ');
      project.duration = parseFloat(v) || 10;
    }
  }

  const key = projectKey(proj.rootDir, entryFile, proj.baseName, bundle.name);
  // With several compositions in one project, the output file name must say
  // WHICH one -- and it has to come from the path, because they are all called
  // index.html. Without this a queue of four videos leaves you one file.
  const name = proj.bundles.length > 1
    ? `${proj.baseName}_${bundle.name || key.name}`
    : proj.baseName;

  return {
    project, url,
    rootDir: proj.rootDir,
    entryFile,
    workDir: proj.workDir,
    name,
    projectId: key.id,
    entryRel: key.rel,
    entryHash: fileHash(entryFile),
    bundleCount: proj.bundles.length,
    cleanup: async () => {},          // the project owns the server
  };
}

/**
 * Render one bundle end to end, unattended. This is the queue's unit of work,
 * so it takes no prompts and returns a result instead of throwing.
 */
async function renderQueued(proj, bundle) {
  const session = await openBundle(proj, bundle);
  const scenes = session.project.scenes || [];
  let window = null;
  if (OPT.scene) {
    window = resolveSelection(scenes, OPT.scene);
    // A scene selection that means nothing for THIS composition is not a reason
    // to abandon the item -- the queue renders whatever the name does match, and
    // the whole timeline where it matches nothing.
    if (!window) console.log(c.y(`  No scene matched "${OPT.scene}" here; rendering the whole timeline.`));
  }
  const cfg = makeConfig(session, OPT.res || '4k', OPT.fps || 60, { window });
  banner(session, cfg);
  const res = await run(cfg, OPT.action && OPT.action !== 'doctor' ? OPT.action : 'render');
  return { ...res, outFile: cfg.outFile };
}

(async () => {
  if (OPT.help) { console.log(HELP); return; }

  if (!ffmpegBin()) {
    console.log(c.y('\n  Heads up: no ffmpeg found. Frames will still render, but nothing can be'));
    console.log(c.y('  encoded. Run `npm install` in this folder to fetch the bundled build.'));
  }

  const proj = await openProject();
  try {
    if (OPT.listEntries) {
      printBundles(proj.bundles);
      console.log(c.dim(`\n  Render one with --entry <path>, or all of them with --all.\n`));
      return;
    }

    // ---- queue ---------------------------------------------------------------
    if (OPT.all || OPT.queue) {
      if (OPT.out) {
        console.log(c.y('\n  --out names a single file, so it cannot be combined with a queue.'));
        console.log(c.dim('  Each queued composition writes its own file next to the project.'));
        process.exitCode = 1;
        return;
      }
      const items = resolveQueue(proj.bundles, OPT.all ? 'all' : OPT.queue);
      if (!items.length) {
        console.log(c.r(`\n  Nothing in this project matched --queue "${OPT.queue}".`));
        printBundles(proj.bundles);
        console.log('');
        process.exitCode = 1;
        return;
      }
      console.log(c.dim(`\n  Queued ${items.length} composition(s):`));
      items.forEach((b, i) => console.log(c.dim(`    ${i + 1}. ${b.rel}`)));
      if (!OPT.yes && !(await confirm(`\n  Render all ${items.length} now?`, true))) return;

      const results = await runQueue(items, (b) => renderQueued(proj, b));
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      console.log('');
      return;
    }

    // ---- one composition -----------------------------------------------------
    const bundle = await pickBundle(proj);
    const session = await openBundle(proj, bundle);
    const scenes = session.project.scenes || [];

    if (OPT.listScenes) {
      if (!scenes.length) console.log(c.y('\n  This composition does not declare a scene list.'));
      else printScenes(scenes, { fps: OPT.fps || 60 });
      console.log('');
      return;
    }

    // A scene selection narrows every subsequent action to that slice.
    let window = null;
    if (OPT.scene) {
      window = resolveSelection(scenes, OPT.scene);
      if (!window) {
        console.log(c.r(`\n  No scene matched "${OPT.scene}".`));
        printScenes(scenes, { fps: OPT.fps || 60 });
        console.log('');
        process.exitCode = 1;
        return;
      }
      console.log(c.dim(`\n  Scene selection: ${window.names.join(' + ')} ` +
        `(${window.start.toFixed(1)}s – ${window.end.toFixed(1)}s)`));
      if (!window.contiguous) {
        console.log(c.y('  Those scenes are not adjacent; everything between them is included.'));
      }
    }

    if (OPT.action) {
      const cfg = makeConfig(session, OPT.res || '4k', OPT.fps || 60, { window });
      banner(session, cfg);
      if (OPT.action === 'doctor')  { await runDoctor(session, cfg); return; }
      if (OPT.action === 'preview') { await renderPreview(session, cfg, 2); return; }
      // A refused or failed render must not look like success to a script.
      const res = await run(cfg, OPT.action);
      if (!res || !res.ok) process.exitCode = 1;
      return;
    }
    await mainMenu(session, window, proj);
    console.log('');
  } finally {
    await proj.cleanup();
  }
})()
  .catch((err) => {
    console.error('\n' + c.r(err.stack || err.message));
    console.error(c.dim('\n  Frames already rendered are safe. Re-run and choose ' +
      '"Fill gaps and export" to carry on.\n'));
    process.exitCode = 1;
  })
  .finally(closePrompt);
