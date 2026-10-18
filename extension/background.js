// Service worker: keeps the job list for the popup, saves finished files through
// chrome.downloads, adds header rules for the engine, and routes the popup's
// requests to the engine (an offscreen document running yt-dlp).
import { makeStore } from './lib/store.js';
import { loadSettings as loadSaved } from './settings.js';

const ENDED = ['done', 'failed', 'cancelled'];

// The settings plus the imported login cookies (kept apart: they're not a preference).
async function loadSettings() {
  const { imported } = await chrome.storage.local.get('imported');
  return { ...(await loadSaved()), cookies: imported?.text || '' };
}
const jobsStore = makeStore('jobs');

// ---------- the engine ----------

let creating = null;
const hasEngine = async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;

async function ensureEngine() {
  if (await hasEngine()) return;
  creating ||= chrome.offscreen
    .createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Runs yt-dlp and joins downloaded video, audio and subtitles into one file.' })
    .finally(() => (creating = null));
  await creating;
}


async function toEngine(msg) {
  await ensureEngine();
  for (let i = 0; i < 50; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'engine', ...msg });
      if (res !== undefined) return res;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("The download engine didn't start.");
}

// After a browser or worker restart without the engine, unfinished jobs can't go on.
(async () => {
  if (await hasEngine()) return;
  jobsStore.update((s) => {
    let changed = false;
    for (const j of Object.values(s)) {
      if (ENDED.includes(j.state) || j.state === 'expanded') continue;
      Object.assign(j, { state: 'failed', error: 'Interrupted. Start it again.', progress: null });
      changed = true;
    }
    return changed;
  });
})();

// ---------- finding videos ----------

// Each page is read as it opens, so the popup has it ready and the toolbar icon
// shows how many videos there are (1, or a playlist's count). Only on sites yt-dlp
// has an extractor for: reading any other page would mean fetching it again.
const detected = makeStore('detected'); // tab id -> { url, summary, playlist }
const reading = new Map(); // tab id -> the URL being read
chrome.action.setBadgeBackgroundColor({ color: '#d92d20' });
chrome.action.setBadgeTextColor({ color: '#ffffff' });

async function detect(tabId, url) {
  reading.set(tabId, url);
  const current = () => reading.get(tabId) === url;
  await detected.update((s) => s[tabId] && delete s[tabId]);
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  if (!/^https?:/.test(url)) return;
  try {
    const settings = await loadSettings();
    const { summary, error } = await toEngine({ cmd: 'detect', url, settings });
    if (!current() || error || !summary) return;
    // A video in a playlist: the playlist too, for the popup's question. Not for
    // YouTube Mixes (list=RD…): they're endless radio lists, not playlists.
    let playlist = null;
    const list = new URL(url).searchParams.get('list') || '';
    if (summary.kind === 'video' && list && !list.startsWith('RD')) {
      const res = await toEngine({ cmd: 'analyze', url, playlist: true, settings }).catch(() => null);
      if (res?.summary?.kind === 'playlist') playlist = res.summary;
    }
    if (!current()) return;
    await detected.update((s) => (s[tabId] = { url, summary, playlist }));
    const count = summary.kind === 'playlist' ? summary.count : 1;
    chrome.action.setBadgeText({ tabId, text: count > 999 ? '999+' : String(count || '') }).catch(() => {});
  } catch (e) {}
}

chrome.tabs.onUpdated.addListener((tabId, { url }) => url && detect(tabId, url));
chrome.tabs.onRemoved.addListener((tabId) => {
  reading.delete(tabId);
  detected.update((s) => s[tabId] && delete s[tabId]);
});

// ---------- saving ----------

// No onDeterminingFilename listener here: a listener can't stay out of other
// extensions' downloads (even an empty suggest() overrides their names and raises a
// filename-conflict warning). So a file is named by the download itself instead.

// A link's download attribute is the download's own name, as a server's
// Content-Disposition would be, so no other extension's listener can drop it. It
// can't make folders, though, and follows Chrome's "ask where to save" setting. The
// engine clicks it, since the blob is its own and the worker has no document.
function saveWithLink({ blobUrl, filename }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (downloadId) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onCreated.removeListener(onCreated);
      resolve(downloadId);
    };
    // Blob URLs are unique, so the download with this URL is the one just started.
    const onCreated = (item) => item.url === blobUrl && settle(item.id);
    // If the link didn't start it, the file is still saved, if under a name another extension's listener could drop.
    const fallBack = () => {
      if (!settled) saveWithApi({ blobUrl, filename }).then(settle);
    };
    const timer = setTimeout(fallBack, 10_000);
    chrome.downloads.onCreated.addListener(onCreated);
    toEngine({ cmd: 'clickDownload', blobUrl, filename }).then((res) => res.error && fallBack(), fallBack);
  });
}

// Keeps the playlist's folder and saves without a dialog per file, but Chrome drops
// `filename` (back to the blob's UUID) as soon as any other extension listens to
// onDeterminingFilename.
function saveWithApi({ blobUrl, filename }) {
  return chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify', saveAs: false });
}

// The name Chrome gave a download, once it has one ('' if it never gets one).
function finalName(downloadId) {
  return new Promise((resolve) => {
    const done = (name) => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(name);
    };
    const onChanged = ({ id, filename }) => id === downloadId && filename?.current && done(filename.current);
    const timer = setTimeout(() => done(''), 10_000);
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id: downloadId }).then(([item]) => item?.filename && done(item.filename));
  });
}

// A playlist's file goes in its folder when Chrome keeps the name. If another
// extension made Chrome drop it (the file is named after the blob's UUID), that
// file goes and it's saved again with a link: the right name, without the folder.
async function saveInFolder(f) {
  const downloadId = await saveWithApi(f);
  const uuid = f.blobUrl.split('/').pop();
  const name = (await finalName(downloadId)).split(/[\\/]/).pop();
  if (!name.startsWith(uuid)) return downloadId;
  await chrome.downloads.cancel(downloadId).catch(() => {});
  await chrome.downloads.removeFile(downloadId).catch(() => {});
  await chrome.downloads.erase({ id: downloadId });
  return saveWithLink({ ...f, filename: f.filename.split('/').pop() });
}

// One job can save several files; it's done when all are.
chrome.downloads.onChanged.addListener(async ({ id, state }) => {
  if (!state || state.current === 'in_progress') return;
  const jobs = await jobsStore.get();
  const job = Object.values(jobs).find((j) => j.files?.some((f) => f.downloadId === id));
  if (!job) return;
  const file = job.files.find((f) => f.downloadId === id);
  toEngine({ cmd: 'release', blobUrl: file.blobUrl }).catch(() => {});
  await jobsStore.update((s) => {
    const j = s[job.id];
    const f = j?.files.find((x) => x.downloadId === id);
    if (!f) return;
    f.state = state.current;
    if (state.current !== 'complete') Object.assign(j, { state: 'failed', error: 'Saving the file was cancelled or failed.' });
    else if (j.files.every((x) => x.state === 'complete')) j.state = 'done';
    return true;
  });
  updateParents();
});

// A playlist's own entry is done when all its videos have ended.
function updateParents() {
  return jobsStore.update((s) => {
    let changed = false;
    for (const p of Object.values(s).filter((j) => j.state === 'expanded')) {
      const kids = Object.values(s).filter((j) => j.parent === p.id);
      const ended = kids.filter((j) => ENDED.includes(j.state));
      const progress = { done: ended.length, count: kids.length, failed: kids.filter((j) => j.state === 'failed').length };
      if (JSON.stringify(progress) !== JSON.stringify(p.progress)) (p.progress = progress), (changed = true);
      if (kids.length && ended.length === kids.length) {
        p.state = kids.some((j) => j.state === 'done') ? 'done' : kids.every((j) => j.state === 'cancelled') ? 'cancelled' : 'failed';
        changed = true;
      }
    }
    return changed;
  });
}

// ---------- messages ----------

// From the engine.
const engineHandlers = {
  addRule: async ({ rule }) => (await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] }), { ok: true }),
  removeRules: async ({ ids }) => (await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }), { ok: true }),
  async job({ id, patch }) {
    await jobsStore.update((s) => s[id] && (Object.assign(s[id], patch), true));
    if (patch.state && ENDED.includes(patch.state)) updateParents();
    return { ok: true };
  },
  async addJobs({ jobs }) {
    await jobsStore.update((s) => (jobs.forEach((j) => (s[j.id] = { ...j, created: Date.now() })), true));
    return { ok: true };
  },
  async save({ id, files }) {
    const saved = [];
    for (const f of files) {
      // Only a playlist's files go in a folder.
      const downloadId = await (f.filename.includes('/') ? saveInFolder(f) : saveWithLink(f));
      saved.push({ ...f, downloadId, state: 'in_progress' });
    }
    await jobsStore.update((s) => s[id] && ((s[id].files = saved), true));
    return { ok: true };
  },
};

// From the popup.
const handlers = {
  async analyze({ url, playlist }) {
    return toEngine({ cmd: 'analyze', url, playlist: !!playlist, settings: await loadSettings() });
  },
  async download({ url, mode, playlist, title, overrides = {} }) {
    // This download's choices (quality, subtitles) over the saved defaults.
    const settings = { ...(await loadSettings()), ...overrides };
    const job = { id: crypto.randomUUID(), kind: playlist ? 'playlist' : 'video', url, mode: mode || settings.mode, title: title || '', state: 'queued', created: Date.now() };
    await jobsStore.update((s) => ((s[job.id] = job), true));
    await toEngine({ cmd: 'enqueue', job: { ...job, settings } });
    return { id: job.id };
  },
  async cancel({ id }) {
    await toEngine({ cmd: 'cancel', id });
    return { ok: true };
  },
  async clear() {
    await jobsStore.update((s) => {
      for (const [id, j] of Object.entries(s)) if (ENDED.includes(j.state) && !(j.parent && s[j.parent] && !ENDED.includes(s[j.parent].state))) delete s[id];
      return true;
    });
    return { ok: true };
  },
  versions: () => toEngine({ cmd: 'versions' }),
  // Logins from another browser: its cookies, read by yt-dlp, kept only in this extension.
  async importCookies({ kind, files }) {
    const res = await toEngine({ cmd: 'importCookies', kind, files });
    if (res.error) return res;
    if (!res.count) return { error: 'No cookies could be read from that file.', log: res.log };
    const imported = { text: res.text, count: res.count, domains: res.domains, from: kind, at: Date.now() };
    await chrome.storage.local.set({ imported });
    const { text, ...summary } = imported;
    return { imported: summary, log: res.log };
  },
  async importedCookies() {
    const { imported } = await chrome.storage.local.get('imported');
    if (!imported) return { imported: null };
    const { text, ...summary } = imported;
    return { imported: summary };
  },
  async removeCookies() {
    await chrome.storage.local.remove('imported');
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === 'engine') return;
  const handler = (msg.target === 'worker' ? engineHandlers : handlers)[msg.cmd];
  if (!handler) return;
  handler(msg).then(reply, (e) => reply({ error: e.message }));
  return true;
});
