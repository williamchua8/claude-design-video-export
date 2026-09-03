// ---------------------------------------------------------------------------
// Deterministic time
// ---------------------------------------------------------------------------
//
// THE STUTTER FIX.
//
// A frame-by-frame renderer seeks the composition to t = i/fps and screenshots.
// That is only correct for motion that is a pure function of the seek time.
// Anything driven by the WALL CLOCK instead -- a CSS @keyframes ambient loop, a
// shimmer, a pulsing glow, a rotating conic gradient, a requestAnimationFrame
// ticker, a spring library, a <video> -- keeps advancing on real time.
//
// During capture real time does NOT advance at 1/fps. Frame 0 might take 900 ms
// (cold layer tree), frame 1 takes 180 ms, frame 2 takes 240 ms, and a GC pause
// makes frame 3 take 700 ms. So every wall-clock-driven element lurches forward
// by a different, random amount on every frame. Played back at a constant 60
// fps that reads as exactly what was reported: stutter, judder and "visual lag"
// on some elements while the main timeline is perfectly smooth.
//
// It is not an encoder problem and no bitrate fixes it -- the frames themselves
// are inconsistent. The only real fix is to stop the page from ever seeing real
// time. Everything below replaces the browser's clocks with one virtual clock
// that WE step to exactly i/fps before each capture.
//
// Injected with addInitScript, so it lands before any page script runs.

/**
 * @param {object} opts
 * @param {'off'|'absolute'|'replay'} opts.mode
 * @param {boolean} opts.freezeTimers  also virtualise setTimeout/setInterval
 * @param {number}  opts.seed          seed for the deterministic Math.random
 * @param {number}  opts.epoch         fixed value for Date.now() at t=0
 */
export function determinismScript(opts) {
  const cfg = {
    mode: opts.mode ?? 'absolute',
    freezeTimers: !!opts.freezeTimers,
    seed: opts.seed ?? 0x2f6e2b1,
    epoch: opts.epoch ?? 1735689600000, // 2025-01-01T00:00:00Z
  };

  // This whole function body is stringified and evaluated in the page.
  return [
    (CFG) => {
      if (window.__CDV) return;
      if (CFG.mode === 'off') { window.__CDV = { mode: 'off', disabled: true }; return; }

      // --- keep private, REAL references before anything is replaced ----------
      const realRaf = window.requestAnimationFrame.bind(window);
      const realCaf = window.cancelAnimationFrame.bind(window);
      const realSetTimeout = window.setTimeout.bind(window);
      const realClearTimeout = window.clearTimeout.bind(window);
      const realPerfNow = performance.now.bind(performance);
      const RealDate = Date;

      const S = {
        mode: CFG.mode,
        now: 0,               // virtual milliseconds since page start
        realRaf, realCaf, realSetTimeout, realClearTimeout, realPerfNow,
        births: new WeakMap(),// animation -> virtual ms when we first saw it
        warnings: [],
        stats: { rafFlushed: 0, animsSynced: 0, timersFired: 0 },
      };
      window.__CDV = S;

      // --- clocks -------------------------------------------------------------
      // performance.now() and Date.now() are what nearly every animation library
      // reads. Pointing both at S.now makes "elapsed time" a value we control.
      try {
        Object.defineProperty(performance, 'now', {
          configurable: true, writable: true, value: () => S.now,
        });
      } catch { performance.now = () => S.now; }

      // Date: keep the real class (parsing, formatting, instanceof all intact)
      // and only override "what time is it right now".
      function VirtualDate(...args) {
        if (!(this instanceof VirtualDate)) return new RealDate(CFG.epoch + S.now).toString();
        return args.length === 0 ? new RealDate(CFG.epoch + S.now) : new RealDate(...args);
      }
      VirtualDate.prototype = RealDate.prototype;
      Object.setPrototypeOf(VirtualDate, RealDate);
      VirtualDate.now = () => CFG.epoch + S.now;
      VirtualDate.parse = RealDate.parse;
      VirtualDate.UTC = RealDate.UTC;
      try { window.Date = VirtualDate; } catch {}

      // --- seeded Math.random -------------------------------------------------
      // Particles, "random" jitter and shuffles must produce the SAME sequence on
      // every worker, or two workers rendering neighbouring frames disagree and
      // the seam flickers. mulberry32: tiny, fast, good enough distribution.
      let rngState = CFG.seed >>> 0;
      const mulberry32 = () => {
        rngState = (rngState + 0x6D2B79F5) >>> 0;
        let t = rngState;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      S.resetRandom = () => { rngState = CFG.seed >>> 0; };
      Math.random = mulberry32;

      // --- requestAnimationFrame ---------------------------------------------
      // rAF callbacks are queued but never run on their own. We drain them by
      // hand, handing each one the VIRTUAL timestamp, so an rAF ticker advances
      // by exactly one frame per captured frame instead of by however long the
      // screenshot happened to take.
      const rafCbs = new Map();
      let rafSeq = 1;
      window.requestAnimationFrame = (cb) => { const id = rafSeq++; rafCbs.set(id, cb); return id; };
      window.cancelAnimationFrame = (id) => { rafCbs.delete(id); };

      S.flushRaf = (rounds = 4) => {
        for (let r = 0; r < rounds; r++) {
          if (!rafCbs.size) break;
          const batch = Array.from(rafCbs.entries());
          rafCbs.clear();
          for (const [, cb] of batch) {
            try { cb(S.now); S.stats.rafFlushed++; } catch (e) { S.warnings.push('raf: ' + e.message); }
          }
        }
      };

      // --- virtual timers (opt-in) -------------------------------------------
      // Off by default. Virtualising timers is the most faithful option, but any
      // library that awaits a real timeout during startup (font loaders, some
      // polyfills, network retry logic) will hang, so it stays behind a flag.
      if (CFG.freezeTimers) {
        const timers = new Map();
        let timerSeq = 1;
        window.setTimeout = (fn, delay = 0, ...a) => {
          const id = timerSeq++;
          timers.set(id, { fn, at: S.now + Math.max(0, delay || 0), args: a, every: null });
          return id;
        };
        window.setInterval = (fn, delay = 0, ...a) => {
          const id = timerSeq++;
          const d = Math.max(1, delay || 1);
          timers.set(id, { fn, at: S.now + d, args: a, every: d });
          return id;
        };
        window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };
        S.runTimers = () => {
          for (let guard = 0; guard < 2000; guard++) {
            let next = null;
            for (const [id, t] of timers) if (t.at <= S.now && (!next || t.at < next[1].at)) next = [id, t];
            if (!next) break;
            const [id, t] = next;
            if (t.every) t.at += t.every; else timers.delete(id);
            try { t.fn(...t.args); S.stats.timersFired++; } catch (e) { S.warnings.push('timer: ' + e.message); }
          }
        };
      } else {
        S.runTimers = () => {};
      }

      // --- CSS animations, CSS transitions, WAAPI -----------------------------
      // getAnimations() covers @keyframes, `transition`, and anything a library
      // created through Element.animate(). Pausing each one and writing
      // currentTime by hand converts all of it into a pure function of t.
      //
      //   absolute : currentTime = t. Correct for the common case -- an ambient
      //              loop that exists from load and runs forever.
      //   replay   : currentTime = t - (virtual time the animation first
      //              appeared). Correct for something that mounts mid-timeline,
      //              e.g. a card whose `transition` fires when it enters at
      //              t=4.2s. Requires the worker to have stepped through the
      //              timeline, which capture.js does in replay mode.
      const collectDocs = () => {
        const docs = [document];
        for (const f of document.querySelectorAll('iframe')) {
          try { if (f.contentDocument) docs.push(f.contentDocument); } catch { /* cross-origin */ }
        }
        return docs;
      };

      S.syncAnimations = () => {
        for (const d of collectDocs()) {
          let anims = [];
          try { anims = d.getAnimations ? d.getAnimations({ subtree: true }) : []; } catch { continue; }
          for (const a of anims) {
            try {
              // Scroll/view timelines are not time-based; leave them alone.
              if (a.timeline && !(a.timeline instanceof DocumentTimeline)) continue;
              if (!S.births.has(a)) S.births.set(a, S.now);
              if (a.playState !== 'paused') a.pause();
              const base = CFG.mode === 'replay' ? S.births.get(a) : 0;
              const local = Math.max(0, S.now - base);
              if (a.currentTime !== local) a.currentTime = local;
              S.stats.animsSynced++;
            } catch { /* finished / not seekable */ }
          }
        }
      };

      // --- media --------------------------------------------------------------
      // A <video> plays on its own clock and will smear across frames. Park it on
      // the exact timestamp instead.
      S.syncMedia = () => {
        for (const d of collectDocs()) {
          for (const m of d.querySelectorAll('video, audio')) {
            try {
              if (!m.paused) m.pause();
              const want = S.now / 1000;
              if (isFinite(m.duration) && m.duration > 0) {
                const target = Math.min(want, Math.max(0, m.duration - 1e-3));
                if (Math.abs(m.currentTime - target) > 1e-3) m.currentTime = target;
              }
            } catch {}
          }
        }
      };

      // --- the one entry point capture.js calls -------------------------------
      // Order matters: move the clock, let rAF code react to the new time, then
      // pin every declarative animation to the same instant.
      S.setTime = (seconds) => {
        S.now = seconds * 1000;
        S.runTimers();
        S.flushRaf(4);
        S.syncAnimations();
        S.syncMedia();
        // A second flush catches anything that queued a new rAF in reaction to
        // the first one (very common in React-driven scenes).
        S.flushRaf(2);
        return S.now;
      };

      // Real-time paint wait, used by the renderer. Must use the REAL rAF -- the
      // page-facing one no longer fires by itself.
      S.waitPaint = () => new Promise((res) => realRaf(() => realRaf(() => realSetTimeout(res, 0))));
    },
    cfg,
  ];
}

/**
 * Kill CSS transition timing. A transition is triggered by a state change and
 * runs on its own clock from that moment; when you are scrubbing rather than
 * playing, that is meaningless. In `replay` mode we can drive them properly, so
 * this is only applied for `absolute`.
 */
export const NO_TRANSITIONS_CSS = `
*, *::before, *::after {
  transition-duration: 0s !important;
  transition-delay: 0s !important;
}`;
