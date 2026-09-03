// ---------------------------------------------------------------------------
// Input handling: standalone .html, a project folder, or a .zip from Claude Code
// ---------------------------------------------------------------------------
//
// You should never have to restructure a project to render it. Point the tool at
// whatever Claude gave you:
//
//   render.js --input scene.html          single self-contained file
//   render.js --input ./my-project        a folder
//   render.js --input project.zip         the zip Claude Code hands you
//   render.js                             auto-detects one in the current folder
//
// Everything is then served over a short-lived local HTTP server rather than
// opened with file://. That matters: file:// blocks ES module imports, fetch()
// and some font loads under Chromium's origin rules, so a multi-file project
// that works when you double-click it can still half-load under file://, and a
// half-loaded project renders as missing text or missing panels. Serving over
// http://127.0.0.1 removes that entire class of failure.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// Minimal ZIP reader (store + deflate), so there is no native unzip dependency
// and behaviour is identical on Windows, macOS and Linux.
// ---------------------------------------------------------------------------

function findEOCD(buf) {
  const sig = 0x06054b50;
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  return -1;
}

export function unzipTo(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  const eocd = findEOCD(buf);
  if (eocd < 0) throw new Error(`${path.basename(zipPath)} is not a readable zip archive.`);

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    throw new Error('This zip uses the ZIP64 extension, which this reader does not handle. ' +
      'Unzip it yourself and pass the folder with --input.');
  }

  let p = cdOffset;
  const written = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method     = buf.readUInt16LE(p + 10);
    const compSize   = buf.readUInt32LE(p + 20);
    const nameLen    = buf.readUInt16LE(p + 28);
    const extraLen   = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff   = buf.readUInt32LE(p + 42);
    const name       = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    // Refuse path traversal and absolute paths from a hostile or odd archive.
    const safe = path.normalize(name).replace(/^(\.\.[\\/])+/, '');
    const out = path.join(destDir, safe);
    if (!out.startsWith(destDir)) continue;

    // The local header's name/extra lengths can differ from the central one.
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen  = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else continue;   // unsupported method (bzip2/lzma) -- skip rather than crash

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    written.push(safe);
  }
  if (!written.length) throw new Error('The zip contained no readable files.');
  return written;
}

// ---------------------------------------------------------------------------
// Entry-point discovery
// ---------------------------------------------------------------------------

const SKIP_DIRS = /^(node_modules|\.git|frames|__MACOSX|dist-frames|out)$/i;

export function listHtml(rootDir, maxDepth = 4) {
  const found = [];
  (function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP_DIRS.test(e.name)) walk(path.join(dir, e.name), depth + 1); }
      else if (/\.html?$/i.test(e.name)) found.push(path.join(dir, e.name));
    }
  })(rootDir, 0);
  return found;
}

/** Score an HTML file on how likely it is to be the animation entry point. */
export function scoreHtml(fp, rootDir) {
  let txt = '';
  try { txt = fs.readFileSync(fp, 'utf8'); } catch { return -99; }
  const base = path.basename(fp).toLowerCase();
  let s = 0;
  if (/data-om-exportable-video-with-duration-secs/.test(txt)) s += 10; // Claude Design bundle
  if (/data-om-seek-to-time-frame/.test(txt)) s += 4;
  if (/<Stage[\s>]/.test(txt)) s += 5;
  if (/animations\.jsx/.test(txt)) s += 3;
  if (/__videoMeta|__seek/.test(txt)) s += 3;
  if (/@keyframes|requestAnimationFrame/.test(txt)) s += 1;
  if (base === 'index.html') s += 2;
  if (/standalone/.test(base)) s += 1;
  if (/readme|test|example|template/.test(base)) s -= 3;
  s -= path.relative(rootDir, fp).split(path.sep).length * 0.2;  // prefer shallow
  return s;
}

/**
 * Every plausible animation entry point under rootDir, best first.
 *
 * A .zip exported from Claude Code often holds SEVERAL compositions, each its
 * own bundle. Silently picking the highest-scoring one and rendering it would be
 * wrong -- you usually want a specific one, and rendering all of them
 * unprompted can be half an hour of work nobody asked for. So the caller gets
 * the whole list and decides.
 *
 * `looksLikeBundle` marks the ones that actually carry a Claude Design stage, so
 * supporting files that merely happen to be .html do not clutter the choice.
 */
export function listBundles(rootDir) {
  return listHtml(rootDir)
    .map((fp) => {
      let txt = '';
      try { txt = fs.readFileSync(fp, 'utf8'); } catch {}
      const isBundle =
        /data-om-exportable-video-with-duration-secs/.test(txt) ||
        /__bundler\/(manifest|template)/.test(txt) ||
        /<x-dc[\s>]/.test(txt) ||
        /<Stage[\s>]/.test(txt) ||
        /__videoMeta|__seek/.test(txt);
      // A self-extracting bundle keeps its scene list in a plain inline script,
      // so we can name the piece and show its length before opening a browser.
      // In a packed bundle that script lives inside a JSON-encoded template, so
      // the quotes arrive backslash-escaped -- try the raw form, then unescaped.
      let scenes = null;
      const m = /window\.OM_SCENES\s*=\s*'(\[[\s\S]*?\])'/.exec(txt);
      if (m) {
        for (const cand of [m[1], m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')]) {
          try { const v = JSON.parse(cand); if (Array.isArray(v)) { scenes = v; break; } } catch {}
        }
      }
      return {
        fp,
        rel: path.relative(rootDir, fp).split(path.sep).join('/'),
        score: scoreHtml(fp, rootDir),
        looksLikeBundle: isBundle,
        scenes,
        durationHint: scenes ? scenes.reduce((t, x) => t + (Number(x.dur) || 0), 0) : null,
      };
    })
    .sort((a, b) => (b.looksLikeBundle - a.looksLikeBundle) || (b.score - a.score));
}

export function pickEntryHtml(rootDir) {
  const all = listBundles(rootDir);
  return all.length ? all[0].fp : null;
}

/** If a zip unpacked into a single wrapper folder, treat that folder as the root. */
function descendSingleFolder(dir) {
  for (let i = 0; i < 3; i++) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !/^(__MACOSX|\.DS_Store)$/.test(e.name));
    const files = entries.filter((e) => e.isFile());
    const dirs = entries.filter((e) => e.isDirectory());
    if (files.length === 0 && dirs.length === 1) dir = path.join(dir, dirs[0].name);
    else break;
  }
  return dir;
}

/**
 * Turn whatever the user passed into { rootDir, entryFile, cleanup }.
 */
export function resolveInput(inputPath) {
  const abs = path.resolve(inputPath);
  if (!fs.existsSync(abs)) throw new Error(`Could not find ${abs}`);
  const st = fs.statSync(abs);

  if (st.isFile() && /\.zip$/i.test(abs)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cdv-zip-'));
    unzipTo(abs, tmp);
    const root = descendSingleFolder(tmp);
    const entry = pickEntryHtml(root);
    if (!entry) throw new Error(`No .html file found inside ${path.basename(abs)}.`);
    return {
      rootDir: root, entryFile: entry, fromZip: true,
      bundles: listBundles(root),
      cleanup: () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} },
    };
  }

  if (st.isDirectory()) {
    const root = descendSingleFolder(abs);
    const entry = pickEntryHtml(root);
    if (!entry) throw new Error(`No .html file found under ${abs}.`);
    return { rootDir: root, entryFile: entry, fromZip: false, bundles: listBundles(root), cleanup: () => {} };
  }

  if (!/\.html?$/i.test(abs)) {
    throw new Error(`${path.basename(abs)} is not an .html file, a folder, or a .zip.`);
  }
  return {
    rootDir: path.dirname(abs), entryFile: abs, fromZip: false,
    bundles: [{ fp: abs, rel: path.basename(abs), score: 99, looksLikeBundle: true, scenes: null, durationHint: null }],
    cleanup: () => {},
  };
}

/** Nothing passed? Find the most plausible candidate in the current folder. */
export function autoDetect(cwd = process.cwd()) {
  const zips = fs.readdirSync(cwd).filter((f) => /\.zip$/i.test(f))
    .map((f) => path.join(cwd, f));
  const htmls = listHtml(cwd, 2);
  const candidates = [
    ...htmls.map((fp) => ({ fp, score: scoreHtml(fp, cwd), kind: 'html' })),
    ...zips.map((fp) => ({ fp, score: 0.5, kind: 'zip' })),
  ].sort((a, b) => b.score - a.score);
  return candidates;
}

// ---------------------------------------------------------------------------
// Static server
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.jsx': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

export function startServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const rel = decodeURIComponent(req.url.split('?')[0]);
        const fp = path.join(rootDir, path.normalize(rel));
        if (!fp.startsWith(rootDir) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
          res.writeHead(404); return res.end('not found');
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
          // Some bundles use SharedArrayBuffer/wasm; these headers are harmless
          // otherwise and unblock it when needed.
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        });
        fs.createReadStream(fp).pipe(res);
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server, port, origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
