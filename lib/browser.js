// ---------------------------------------------------------------------------
// Browser launch
// ---------------------------------------------------------------------------
//
// THE "GLOW RENDERS AS A SQUARE" FIX lives here and in the render-scale choice
// in capture.js. Two independent causes, both real:
//
// 1. THE HEADLESS SHELL.
//    Playwright and Puppeteer both ship TWO Chromium binaries:
//      - chrome-headless-shell : the old, cut-down headless build. Small, fast,
//        and it mis-composites filter/backdrop-filter effects that sit under a
//        transform or inside a composited (preserve-3d / translate3d) layer.
//        A `filter: blur(120px)` radial glow gets clipped to the element's
//        rectangular layer bounds -- which is precisely "my radial glow came out
//        as a square". Same for backdrop-filter.
//      - full chromium (new headless) : the real browser with a real compositor.
//        Renders blur exactly like the Chrome on your desktop does.
//    Puppeteer's `headless: true` and the deprecated `headless: 'new'` do NOT
//    reliably get you the full binary across versions -- which is how a script
//    can look correct for months and then start producing square glows after a
//    routine dependency bump. Below we ask for the full build explicitly, and
//    then VERIFY what we actually got rather than trusting the request.
//
// 2. TOO MANY COMPOSITOR FLAGS.
//    --disable-gpu, --disable-partial-raster, --disable-checker-imaging,
//    --run-all-compositor-stages-before-draw and friends each change how layers
//    are rasterised. Under software raster in particular, a large blur is
//    approximated far more crudely, and a big blur radius on a transformed layer
//    can degrade to a box. The flag list below is deliberately short: colour and
//    text consistency, no throttling, nothing that reroutes rasterisation.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

/** Flags we always want. Short on purpose -- see the note above. */
function baseArgs() {
  return [
    // Colour + text consistency for video.
    '--force-color-profile=srgb',
    '--disable-lcd-text',          // grayscale AA; subpixel fringes smear under 4:2:0
    '--font-render-hinting=none',  // identical glyph metrics across machines
    // Housekeeping.
    '--hide-scrollbars',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    // A backgrounded/occluded window must never throttle -- with several workers
    // most of them are occluded by definition.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion,PaintHolding',
  ];
}

/**
 * Rasterisation mode.
 *  'gpu'      (default) -- normal compositing path. Blur, backdrop-filter and
 *             large radial gradients take the same code path as a desktop
 *             browser. In headless this is usually ANGLE/SwiftShader, which is
 *             still the *correct* path, just software-backed.
 *  'software' -- --disable-gpu. Sometimes steadier on very layer-heavy scenes,
 *             but it is the path most likely to box a large blur. Fallback only.
 */
function rasterArgs(raster) {
  if (raster === 'software') return ['--disable-gpu', '--disable-gpu-compositing'];
  return ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
}

const CHANNELS = [
  { channel: 'chromium', label: 'Playwright full Chromium (new headless)' },
  { channel: 'chrome',   label: 'System Google Chrome' },
  { channel: 'msedge',   label: 'System Microsoft Edge' },
  { channel: null,       label: 'Playwright default build' },
];

/**
 * Launch, preferring a full Chromium build, and report which one we got.
 * `browser.version()` plus the resolved executable path tell us whether we
 * landed on the headless shell despite asking not to.
 */
export async function launchBrowser({ raster = 'gpu', channel = null, extraArgs = [] } = {}) {
  const args = [...baseArgs(), ...rasterArgs(raster), ...extraArgs];
  const attempts = channel
    ? [{ channel: channel === 'default' ? null : channel, label: `requested: ${channel}` }]
    : CHANNELS;

  const errors = [];
  for (const attempt of attempts) {
    try {
      const opts = { args, chromiumSandbox: false };
      if (attempt.channel) opts.channel = attempt.channel;
      const browser = await chromium.launch(opts);
      const info = await describeBrowser(browser, attempt);
      return { browser, info };
    } catch (e) {
      errors.push(`${attempt.label}: ${String(e.message).split('\n')[0]}`);
    }
  }
  const err = new Error(
    'Could not start a browser.\n  Tried:\n   - ' + errors.join('\n   - ') +
    '\n\n  Most likely fix:  npx playwright install chromium'
  );
  throw err;
}

async function describeBrowser(browser, attempt) {
  let version = '';
  try { version = browser.version(); } catch {}
  // Playwright does not expose the executable path on the instance, so resolve
  // the one it would use for this channel.
  let execPath = '';
  try { execPath = chromium.executablePath(); } catch {}
  const isShell =
    /headless[_-]?shell/i.test(execPath) ||
    /headless[_-]?shell/i.test(version);

  return {
    label: attempt.label,
    channel: attempt.channel || 'default',
    version,
    execPath,
    isShell,
    shellWarning: isShell
      ? 'This is the cut-down chrome-headless-shell build. It mis-composites ' +
        'blur / backdrop-filter under transforms, which is what turns a radial ' +
        'glow into a rectangle. Run:  npx playwright install chromium'
      : null,
  };
}

/** Does a full (non-shell) Chromium actually exist on this machine? */
export function fullChromiumAvailable() {
  try {
    const p = chromium.executablePath();
    return !!p && fs.existsSync(p) && !/headless[_-]?shell/i.test(p);
  } catch { return false; }
}

export function browserSummary(info) {
  const bits = [info.label];
  if (info.version) bits.push(`v${info.version}`);
  if (info.execPath) bits.push(path.basename(path.dirname(info.execPath)));
  return bits.join('  ');
}
