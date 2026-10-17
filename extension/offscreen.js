// The engine: runs yt-dlp and the downloads in an offscreen document, so they
// keep going when the popup closes. Jobs run one at a time; playlists become one
// job per video, with a pause between them. Saving and the job list for the
// popup are the worker's.
import { ytdlp, setRequestGap, importCookies } from './engine/ytdlp.js';
import { summarize } from './engine/summary.js';
import { runVideo, extractWithLogin, videoSpec, sleep } from './engine/job.js';
import { cleanName } from './engine/names.js';

const toWorker = async (msg) => {
  const res = await chrome.runtime.sendMessage({ target: 'worker', ...msg });
  if (res?.error) throw new Error(res.error);
  return res;
};
const report = (id, patch) => toWorker({ cmd: 'job', id, patch }).catch(() => {});

// Request headers for some hosts, through a header rule the worker adds.
let nextRule = 2_000_000;
async function rules(hosts, headers) {
  const requestHeaders = Object.entries(headers).map(([header, value]) => ({ header, operation: 'set', value }));
  if (!requestHeaders.length || !hosts.length) return async () => {};
  const id = nextRule++;
  await toWorker({ cmd: 'addRule', rule: { id, priority: 1, action: { type: 'modifyHeaders', requestHeaders }, condition: { requestDomains: hosts, initiatorDomains: [chrome.runtime.id] } } });
  return () => toWorker({ cmd: 'removeRules', ids: [id] }).catch(() => {});
}

// ---------- analysis (cached for the download that usually follows) ----------

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();
async function cachedExtract(url, options, settings) {
  // A different login can give a different result.
  const key = JSON.stringify([url, options, settings.cookies?.length || 0]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const info = await extractWithLogin(url, options, settings);
  cache.set(key, { at: Date.now(), info });
  return info;
}

// ---------- the queue ----------

const queue = [];
let current = null; // { job, controller }
const temp = new Map(); // blob URL -> cleanup()

async function pump() {
  if (current || !queue.length) return;
  const job = queue.shift();
  const controller = new AbortController();
  current = { job, controller };
  const { signal } = controller;
  try {
    // Inside a playlist: pause between videos and between requests.
    setRequestGap(job.playlist ? job.settings.sleepRequests : 0);
    if (job.kind === 'playlist') await expand(job, signal);
    else await runOne(job, signal);
  } catch (e) {
    report(job.id, signal.aborted ? { state: 'cancelled' } : { state: 'failed', error: e.message });
  } finally {
    current = null;
    pump();
  }
}

// Playlist entries can be relative to the playlist's address.
const absolute = (url, base) => {
  try {
    return new URL(url, base).href;
  } catch (e) {
    return url; // an ID yt-dlp resolves itself
  }
};

async function expand(job, signal) {
  report(job.id, { state: 'extracting' });
  const info = await extractWithLogin(job.url, { format: videoSpec(job.settings), playlist: true, signal }, job.settings);
  const entries = (info.entries || []).filter((e) => e && (e.url || e.webpage_url || e.id));
  if (!entries.length) throw new Error('The playlist is empty.');
  const children = entries.map((e, i) => ({
    id: crypto.randomUUID(),
    kind: 'video',
    url: absolute(e.url || e.webpage_url || e.id, info.webpage_url || job.url),
    title: e.title || '',
    mode: job.mode,
    settings: job.settings,
    parent: job.id,
    playlist: { title: info.title || 'Playlist', index: i + 1, count: entries.length },
  }));
  await toWorker({ cmd: 'addJobs', parent: job.id, jobs: children.map(({ settings, ...rest }) => ({ ...rest, state: 'queued' })) });
  report(job.id, { state: 'expanded', count: children.length, title: info.title });
  if (signal.aborted) throw signal.reason;
  queue.unshift(...children);
}

async function runOne(job, signal) {
  if (job.playlist && job.playlist.index > 1) {
    const seconds = job.settings.sleepMin + Math.random() * job.settings.sleepRandom;
    report(job.id, { state: 'waiting', until: Date.now() + seconds * 1000 });
    await sleep(seconds, signal);
  }
  const result = await runVideo(job, { settings: job.settings, signal, rules, report: (patch) => report(job.id, patch) });
  const folder = job.playlist ? `${cleanName(job.playlist.title, 'Playlist')}/` : '';
  const files = result.files.map((f) => {
    const blobUrl = URL.createObjectURL(f.blob);
    temp.set(blobUrl, () => (URL.revokeObjectURL(blobUrl), f.cleanup?.()));
    return { blobUrl, filename: `${folder}${f.name}.${f.ext}` };
  });
  report(job.id, { state: 'saving', notes: result.notes, progress: null });
  await toWorker({ cmd: 'save', id: job.id, files });
}

// ---------- messages ----------

const handlers = {
  async analyze({ url, playlist, settings }) {
    const info = await cachedExtract(url, { format: videoSpec(settings), playlist: !!playlist }, settings);
    return { summary: summarize(info) };
  },
  async enqueue({ job }) {
    queue.push(job);
    pump();
    return { ok: true };
  },
  async cancel({ id }) {
    const i = queue.findIndex((j) => j.id === id || j.parent === id);
    for (let k = queue.length - 1; k >= 0; k--) {
      if (queue[k].id === id || queue[k].parent === id) report(queue.splice(k, 1)[0].id, { state: 'cancelled' });
    }
    if (current && (current.job.id === id || current.job.parent === id)) current.controller.abort(new DOMException('Cancelled', 'AbortError'));
    return { ok: true, queued: i >= 0 };
  },
  // For the worker's saveWithLink: a link's download attribute names the file.
  async clickDownload({ blobUrl, filename }) {
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    link.click();
    return { ok: true };
  },
  async release({ blobUrl }) {
    temp.get(blobUrl)?.();
    temp.delete(blobUrl);
    return { ok: true };
  },
  async importCookies({ kind, files }) {
    const decoded = files.map((f) => ({ name: f.name, bytes: Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0)) }));
    return importCookies(kind, decoded);
  },
  async versions() {
    return (await ytdlp()).versions;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target !== 'engine') return;
  const handler = handlers[msg.cmd];
  if (!handler) return;
  handler(msg).then(reply, (e) => reply({ error: e.message }));
  return true;
});

ytdlp(); // start loading yt-dlp right away
