// ---------------------------------------------------------------------------
// Bundle detection
// ---------------------------------------------------------------------------
//
// Three shapes of Claude Design / Claude Artifact export are supported, and the
// renderer picks whichever one the file actually is. Nothing is hardcoded to a
// single project: size, duration and (where available) native frame rate are all
// read off the page at run time.
//
//   om     : the "animations-v3" bundle Claude Design produces. A stage element
//            carrying data-om-exportable-video-with-duration-secs, driven by
//            dispatching a data-om-seek-to-time-frame CustomEvent.
//   stage   : the animations.jsx <Stage> starter, which exposes window.__seek
//            and window.__videoMeta when loaded with ?__render=1.
//   clock   : no seek API at all. Because determinism.js has already replaced
//            every clock in the page, we can still render any plain CSS / rAF
//            animation correctly just by stepping the virtual clock. This is the
//            fallback, and it is a real one -- not a stub.

import path from 'node:path';
import { launchBrowser } from './browser.js';
import { readScenes, scenesTotal } from './scenes.js';

export const OM_STAGE_SELECTOR = '[data-om-exportable-video-with-duration-secs]';

export const ADAPTERS = {
  // ---- Claude Design animations-v3 -------------------------------------------
  om: {
    label: 'Claude Design bundle (animations-v3)',
    detect: (sel) => !!document.querySelector(sel),
    read: (sel) => {
      const el = document.querySelector(sel);
      const num = (a) => { const v = parseFloat(el.getAttribute(a)); return isFinite(v) ? v : null; };
      return {
        width: num('width'),
        height: num('height'),
        duration: num('data-om-exportable-video-with-duration-secs'),
        nativeFps: num('fps') || num('data-om-fps') || null,
        syncSeek: el.getAttribute('data-om-sync-seek') === 'true',
      };
    },
    seek: (sel, time) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.dispatchEvent(new CustomEvent('data-om-seek-to-time-frame', {
        detail: { time, sync: true, playing: false },
      }));
      return true;
    },
    ready: (sel) => {
      const el = document.querySelector(sel);
      // The engine inlines ~30 @font-face rules into a foreignObject
      // asynchronously. If that lands mid-capture, text reflows between frames.
      return !!el && el.getAttribute('data-om-fonts-inlined') === 'true';
    },
  },

  // ---- animations.jsx <Stage> starter -----------------------------------------
  stage: {
    label: 'Stage starter (window.__seek)',
    detect: () => typeof window.__seek === 'function' && !!window.__videoMeta,
    read: () => {
      const m = window.__videoMeta || {};
      return {
        width: m.width, height: m.height, duration: m.duration,
        nativeFps: m.fps || null, syncSeek: true,
      };
    },
    seek: (sel, time) => { window.__seek(time); return true; },
    ready: () => window.__ready === true,
  },

  // ---- plain page, virtual clock only ------------------------------------------
  clock: {
    label: 'Plain page (virtual-clock only)',
    detect: () => true,
    read: () => ({
      width: window.innerWidth, height: window.innerHeight,
      duration: null, nativeFps: null, syncSeek: true,
    }),
    seek: () => true,            // determinism.js setTime() already did the work
    ready: () => document.readyState === 'complete',
  },
};

/** Serialise an adapter's functions so they can be handed to page.evaluate. */
export function adapterSource(kind) {
  const a = ADAPTERS[kind];
  return {
    kind,
    label: a.label,
    seekSrc: a.seek.toString(),
    readySrc: a.ready.toString(),
  };
}

/**
 * Open the bundle once, work out what it is and how big it is, and close.
 * Also reports the GPU string, which is useful when a machine renders
 * differently from the one the project was authored on.
 */
export async function probeProject(input, { raster = 'gpu', channel = null, angle = null, timeout = 180000 } = {}) {
  const { browser, info } = await launchBrowser({ raster, channel, angle });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(toUrl(input), { waitUntil: 'load', timeout });

    // Give the bundle a moment to mount before deciding what it is.
    await page.waitForTimeout(500);
    try {
      await page.waitForFunction(
        (sel) => !!document.querySelector(sel) || (typeof window.__seek === 'function'),
        OM_STAGE_SELECTOR, { timeout: 20000, polling: 250 },
      );
    } catch { /* falls through to the clock adapter */ }

    const detected = await page.evaluate((sel) => {
      const hasOm = !!document.querySelector(sel);
      const hasStage = typeof window.__seek === 'function' && !!window.__videoMeta;
      return hasOm ? 'om' : hasStage ? 'stage' : 'clock';
    }, OM_STAGE_SELECTOR);

    let meta = await page.evaluate(
      ({ sel, readSrc }) => (new Function('return ' + readSrc))()(sel),
      { sel: OM_STAGE_SELECTOR, readSrc: ADAPTERS[detected].read.toString() },
    );

    const gpu = await page.evaluate(() => {
      try {
        const gl = document.createElement('canvas').getContext('webgl');
        const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
      } catch { return null; }
    });

    // The composition's own section list, when it declares one. This is what
    // makes "render just the IPAM scene" possible without asking for timestamps.
    const scenes = await readScenes(page);
    // Scene durations are the authoritative playback length when present -- the
    // stage attribute can lag behind a retime on the host timeline.
    const sceneDur = scenesTotal(scenes);
    if (sceneDur > 0 && Math.abs(sceneDur - (meta.duration || 0)) > 0.05) {
      meta = { ...meta, duration: meta.duration || sceneDur };
    }

    await ctx.close();
    return { adapter: detected, browserInfo: info, gpu, pageErrors: errors, scenes, ...meta };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Local paths become absolute file:// URLs; http(s) inputs pass straight through. */
export function toUrl(input) {
  if (/^https?:\/\//i.test(input)) return input;
  return 'file://' + path.resolve(input).replace(/\\/g, '/');
}
