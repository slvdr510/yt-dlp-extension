// End-to-end harness: a local media server and Chromium with the extension
// loaded (started directly and attached over CDP, so downloads keep their names).
import { createServer } from 'node:http';
import { createReadStream, statSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { makeFixtures } from '../fixtures/make.mjs';

export const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '../../extension');
const TYPES = { '.html': 'text/html', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt', '.jpg': 'image/jpeg', '.mpd': 'application/dash+xml', '.m4s': 'video/iso.segment', '.xml': 'application/rss+xml' };

export async function startServer() {
  const dir = makeFixtures();
  const hooks = [];
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    log.push({ path: url.pathname, headers: req.headers });
    for (const h of hooks) if (h(req, res, url)) return;
    const file = join(dir, decodeURIComponent(url.pathname));
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) return res.writeHead(404).end();
    const size = statSync(file).size;
    const headers = { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'accept-ranges': 'bytes' };
    const m = (req.headers.range || '').match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size) return res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': size });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, hooks, log, close: () => new Promise((r) => server.close(r)) };
}

// `others`: more extensions to load next to this one (folders).
export async function launch({ others = [] } = {}) {
  const exts = [EXT, ...others].join(',');
  const profile = mkdtempSync(join(tmpdir(), 'ytx-profile-'));
  const downloads = mkdtempSync(join(tmpdir(), 'ytx-downloads-'));
  const removeTemp = () => {
    rmSync(profile, { recursive: true, force: true });
    rmSync(downloads, { recursive: true, force: true });
  };
  process.on('exit', removeTemp);
  // Also when the run is killed (a timeout, Ctrl+C): exit handlers alone don't run then.
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => (removeTemp(), process.exit(130)));
  mkdirSync(join(profile, 'Default'), { recursive: true });
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
  const proc = spawn(chromium.executablePath(), [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-extension-debugging', `--disable-extensions-except=${exts}`, `--load-extension=${exts}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    proc.on('exit', () => reject(new Error(`Chromium exited: ${err}`)));
  });
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  const isOurs = async (w) => w.url().startsWith('chrome-extension://') && (await w.evaluate(() => chrome.runtime.getManifest().name).catch(() => '')) === 'yt-dlp-extension';
  let sw = null;
  for (const end = Date.now() + 10000; !sw && Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    for (const w of context.serviceWorkers()) if (await isOurs(w)) sw = w;
  }
  if (!sw) throw new Error('The extension did not load');
  const extId = new URL(sw.url()).host;
  const ext = await context.newPage();
  await ext.goto(`chrome-extension://${extId}/popup.html`);

  const api = {
    browser, context, sw, ext, extId, downloads, endpoint,
    send: (msg) => ext.evaluate((m) => chrome.runtime.sendMessage(m), msg),
    session: (key) => sw.evaluate(async (k) => (await chrome.storage.session.get(k))[k], key),
    // Waits until job `id` reaches one of `states`; returns it.
    async job(id, states = ['done', 'failed', 'cancelled'], timeout = 60000) {
      let job;
      for (const end = Date.now() + timeout; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) {
        job = ((await api.session('jobs')) || {})[id];
        if (job && states.includes(job.state)) return job;
      }
      throw new Error(`Timed out waiting for ${states}; last: ${JSON.stringify(job)}`);
    },
    // Where a finished job's files were saved.
    files: (job) => sw.evaluate(async (ids) => Promise.all(ids.map(async (id) => (await chrome.downloads.search({ id }))[0]?.filename)), (job.files || []).map((f) => f.downloadId)),
    settings: (patch) => sw.evaluate(async (p) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, ...p } });
    }, patch),
    close: async () => {
      await browser.close().catch(() => {});
      proc.kill();
      await new Promise((r) => (proc.exitCode !== null ? r() : proc.on('exit', r)));
      removeTemp();
    },
  };
  return api;
}

export function probe(file) {
  const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', file]).toString());
  return {
    format: out.format.format_name,
    duration: Number(out.format.duration),
    tags: out.format.tags || {},
    chapters: out.chapters || [],
    streams: out.streams.map((s) => ({ type: s.codec_type, codec: s.codec_name, lang: s.tags?.language, disposition: s.disposition, width: s.width, height: s.height })),
  };
}

export function decodeErrors(file) {
  try {
    return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (e) {
    return e.stderr.toString() || e.message;
  }
}
