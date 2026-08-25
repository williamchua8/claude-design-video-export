// ---------------------------------------------------------------------------
// Browser launch
// ---------------------------------------------------------------------------
//
// Which binary renders the page, and which graphics backend it rasterises
// through, are the two things most likely to make a blur or glow come out wrong
// on one machine while looking correct everywhere else.
//
// 1. THE HEADLESS SHELL.
//    Playwright and Puppeteer both ship TWO Chromium binaries:
//      - chrome-headless-shell : the old, cut-down headless build. It is
//        reported to mis-composite filter/backdrop-filter effects sitting under
//        a transform, clipping them to the element's rectangular layer bounds.
//      - full chromium (new headless) : the real browser with a real compositor.
//    Puppeteer's `headless: true` and the deprecated `headless: 'new'` do not
//    reliably select the full binary across versions, which is how a script can
//    work for months and then change behaviour after a dependency bump. Below we
//    request the full build explicitly and then VERIFY what we actually got
//    rather than trusting the request.
//
// 2. THE ANGLE BACKEND -- see angleArgs() below.
//    This is the axis that survived investigation. A large-sigma blur
//    mis-rasterising is the kind of fault that lives in a specific GPU driver,
//    and neither supersampling nor the software/GPU raster toggle changes which
//    driver ANGLE talks to. --angle swiftshader removes the vendor driver from
//    the picture entirely, which both diagnoses the problem and works around it.
//
// What is NOT the cause, tested and ruled out: Claude Design renders its content
// inside an SVG <foreignObject>, which is a known Chromium filter-clipping path
// and an obvious suspect. Re-parenting the live content out of the foreignObject
// into plain DOM and re-rendering the same frame produced a mean pixel
// difference of 0. It is not that.
//
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
    '--disable-features=CalculateNativeWinOcclusion,PaintHolding,LazyFrameLoading',
  ];
}

/**
 * Anti-dropout flags: make the compositor finish before a frame is handed over.
 *
 * These target the confirmed "a section of the panel is missing for one frame"
 * bug. Each one removes an async path that lets a frame be serialised while part
 * of the layer tree is still being rasterised:
 *
 *   run-all-compositor-stages-before-draw  finish every compositor stage first
 *   disable-new-content-rendering-timeout  never give up and draw stale/blank
 *   disable-checker-imaging                no placeholder fill for un-rastered tiles
 *   disable-partial-raster                 rasterise whole tiles, not deltas
 *   disable-threaded-animation/scrolling   fewer off-main-thread paint paths
 *
 * OFF by default, and the reason is stability rather than speed. They are not
 * slow -- measured on a real 4K bundle they came out slightly FASTER
 * (2448 ms/frame against 3132 ms/frame). But --run-all-compositor-stages-
 * before-draw can deadlock Page.captureScreenshot: the compositor waits for a
 * main-frame update that never arrives, because determinism.js owns
 * requestAnimationFrame and a pinned scene schedules no animation of its own.
 * Observed directly as a 120 s screenshot timeout on a static-after-pinning
 * composition, which would turn into a stalled render rather than a bad frame.
 *
 * Since sweep.js detects and repairs dropouts directly and is validated against
 * a real failure, the guarantee does not depend on these flags -- so the
 * trade is a stall risk against an unmeasured benefit, and they stay off.
 * Enable with --paint-determinism if you want them. Kept separate from the raster-mode
 * flags because these are about WHEN a frame is captured, not HOW it is drawn --
 * conflating the two is what leads people to disable the GPU and then wonder why
 * their blurs got worse.
 */
function paintDeterminismArgs() {
  return [
    '--run-all-compositor-stages-before-draw',
    '--disable-new-content-rendering-timeout',
    '--disable-checker-imaging',
    '--disable-partial-raster',
    '--disable-threaded-animation',
    '--disable-threaded-scrolling',
  ];
}

/**
 * ANGLE backend. This is the axis most likely to matter for a blur or glow that
 * renders wrongly on ONE machine while looking fine everywhere else, because it
 * selects which graphics driver actually rasterises the page:
 *
 *   default     let Chromium choose (d3d11 on Windows, gl/metal elsewhere)
 *   d3d11       Direct3D 11 -- the Windows default
 *   d3d9        older Direct3D path
 *   gl          desktop OpenGL
 *   vulkan      Vulkan
 *   swiftshader ANGLE's own CPU rasteriser: no vendor driver involved at all
 *
 * If a glow renders as a rectangle under d3d11 but correctly under swiftshader,
 * the bug is in the GPU driver, not in the composition or this renderer.
 * swiftshader is slower but completely driver-independent, which makes it a
 * usable fallback for a final render, not just a diagnostic.
 */
function angleArgs(angle) {
  if (!angle || angle === 'default') return [];
  return [`--use-angle=${angle}`, '--use-gl=angle'];
}

export const ANGLE_BACKENDS = ['default', 'd3d11', 'd3d9', 'gl', 'vulkan', 'swiftshader'];

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
export async function launchBrowser({ raster = 'gpu', channel = null, angle = null, paintDeterminism = false, extraArgs = [] } = {}) {
  const args = [
    ...baseArgs(),
    ...(paintDeterminism ? paintDeterminismArgs() : []),
    ...rasterArgs(raster),
    ...angleArgs(angle),
    ...extraArgs,
  ];
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
