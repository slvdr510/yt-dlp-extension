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

// yt-dlp takes a few seconds to load: on a YouTube video it starts loading right
// away, so it's ready when the popup opens.
const YOUTUBE_VIDEO = /^https:\/\/(www\.|m\.|music\.)?youtube\.com\/(watch|shorts\/|live\/)/;
chrome.tabs.onUpdated.addListener((tabId, { url }) => {
  if (url && YOUTUBE_VIDEO.test(url)) ensureEngine().catch(() => {});
});

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

// ---------- saving ----------

// Names for the files being saved, by blob URL. When another extension listens to
// onDeterminingFilename, Chrome drops the name given to downloads.download(), so
// it's suggested again here (when several extensions suggest, the one installed
// last wins). Other downloads are left alone.
const names = new Map();
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = item.byExtensionId === chrome.runtime.id && names.get(item.url);
  if (!filename) return suggest();
  names.delete(item.url);
  suggest({ filename, conflictAction: 'uniquify' });
});

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
      names.set(f.blobUrl, f.filename);
      const downloadId = await chrome.downloads.download({ url: f.blobUrl, filename: f.filename, conflictAction: 'uniquify', saveAs: false });
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
