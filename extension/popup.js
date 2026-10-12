// The popup: analyzes the current tab with yt-dlp, offers the download, and
// lists the downloads. Everything is shown with textContent (no HTML from pages).
import { loadSettings, saveSettings } from './settings.js';
import { BROWSERS, SYSTEMS, detectSystem, hintsFor } from './cookie-paths.js';

const $ = (id) => document.getElementById(id);
const send = async (cmd, data = {}) => {
  const res = await chrome.runtime.sendMessage({ cmd, ...data });
  if (res?.error) throw new Error(res.error);
  return res;
};
const el = (tag, props = {}, children = []) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c) e.append(c);
  return e;
};

const state = { url: '', summary: null, playlist: null, mode: 'video', settings: null };

const formatDuration = (s) => {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
};
const formatSize = (n) => (!n ? '' : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(2)} GB`);

// ---------- the current tab ----------

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  const video = mode === 'video';
  $('quality').classList.toggle('hidden', !video);
  $('subsRow').classList.toggle('hidden', !video || !subtitleCount());
  $('modeHint').textContent = video ? 'Best video and sound in one MP4, with subtitles and chapters.' : 'Sound only (M4A), with the cover art and song details embedded.';
}

const subtitleCount = () => {
  const s = state.summary?.subtitles;
  return s ? s.creator.length + (s.auto && !s.creator.some((l) => s.auto.startsWith(l)) ? 1 : 0) : 0;
};

function showSummary() {
  const s = state.summary;
  $('status').classList.add('hidden');
  $('found').classList.remove('hidden');
  $('title').textContent = s.title || state.url;
  if (s.kind === 'playlist') {
    $('thumb').classList.add('hidden');
    $('sub').textContent = [s.uploader, `${s.count} videos`].filter(Boolean).join(' · ');
  } else {
    if (s.thumbnail) $('thumb').src = s.thumbnail;
    else $('thumb').classList.add('hidden');
    $('sub').textContent = [s.uploader, s.live ? 'live' : s.duration ? formatDuration(s.duration) : '', s.extractor !== 'Youtube' ? s.extractor : ''].filter(Boolean).join(' · ');
  }
  // A video inside a playlist (or a playlist link): choose one or all.
  const list = state.playlist || (s.kind === 'playlist' ? s : null);
  $('scope').classList.toggle('hidden', !list || s.kind === 'playlist');
  if (list) $('scopeList').textContent = `Whole playlist (${list.count})`;

  const heights = s.heights || [];
  $('quality').replaceChildren(
    el('option', { value: '0', textContent: heights[0] ? `Best (${heights[0]}p)` : 'Best' }),
    ...heights.filter((h) => h >= 240).map((h) => el('option', { value: String(h), textContent: `${h}p` }))
  );
  $('quality').value = String(state.settings.maxHeight && heights.includes(state.settings.maxHeight) ? state.settings.maxHeight : 0);
  $('subs').checked = state.settings.subtitles;
  $('subsLabel').textContent = `Subtitles (${subtitleCount()})`;
  const mode = state.settings.mode === 'auto' ? (s.music ? 'music' : 'video') : state.settings.mode;
  setMode(mode);
}

async function analyze() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.url = tab?.url || '';
  if (!/^https?:/.test(state.url)) {
    $('status').textContent = 'Open a page with a video to download it.';
    return;
  }
  try {
    const { summary } = await send('analyze', { url: state.url });
    state.summary = summary;
    // A video in a playlist: learn the playlist's size too (fast, flat listing).
    if (summary.kind === 'video' && /[?&]list=/.test(state.url)) {
      send('analyze', { url: state.url, playlist: true })
        .then(({ summary: p }) => {
          if (p.kind === 'playlist') (state.playlist = p), showSummary();
        })
        .catch(() => {});
    }
    showSummary();
  } catch (e) {
    $('status').textContent = /Unsupported URL/i.test(e.message) ? 'No video yt-dlp can download on this page.' : e.message;
  }
}

$('modeVideo').onclick = () => setMode('video');
$('modeMusic').onclick = () => setMode('music');

$('go').onclick = async () => {
  $('go').disabled = true;
  try {
    const playlist = state.summary.kind === 'playlist' || document.querySelector('input[name=scope]:checked')?.value === 'playlist';
    // This download's choices (quality, subtitles) without changing the defaults.
    const overrides = { maxHeight: Number($('quality').value) || 0, subtitles: $('subs').checked };
    await send('download', { url: state.url, mode: state.mode, playlist, title: playlist ? (state.playlist || state.summary).title : state.summary.title, overrides });
  } catch (e) {
    $('status').textContent = e.message;
    $('status').classList.remove('hidden');
  } finally {
    setTimeout(() => ($('go').disabled = false), 800);
  }
};

// ---------- downloads ----------

const STATE_TEXT = {
  queued: 'Waiting',
  extracting: 'Reading the video…',
  downloading: 'Downloading',
  writing: 'Putting the file together…',
  saving: 'Saving…',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expanded: 'Playlist',
};
const ACTIVE = ['queued', 'extracting', 'downloading', 'writing', 'saving', 'waiting', 'expanded'];

function jobRow(job, child) {
  let text = STATE_TEXT[job.state] || job.state;
  let pct = null;
  if (job.state === 'waiting') text = `Pausing ${Math.max(0, Math.ceil((job.until - Date.now()) / 1000))} s (playlist)`;
  if (job.state === 'downloading' && job.progress) {
    const { bytes, total, part, parts } = job.progress;
    pct = total ? Math.min(100, (bytes / total) * 100) : null;
    text = [`Downloading${parts > 1 ? ` ${part}/${parts}` : ''}`, total ? `${formatSize(bytes)} of ${formatSize(total)}` : formatSize(bytes)].filter(Boolean).join(' · ');
  }
  if (job.state === 'expanded' && job.progress) {
    text = `Playlist · ${job.progress.done}/${job.progress.count}${job.progress.failed ? ` · ${job.progress.failed} failed` : ''}`;
    pct = (job.progress.done / job.progress.count) * 100;
  }
  const name = (job.playlist ? `${job.playlist.index}. ` : '') + (job.title || job.url);
  const actions = [];
  if (ACTIVE.includes(job.state) && !(child && job.state === 'expanded')) {
    actions.push(el('button', { className: 'link', textContent: 'Cancel', onclick: () => send('cancel', { id: job.id }) }));
  }
  if (job.state === 'done' && job.files?.[0]?.downloadId) {
    actions.push(el('button', { className: 'link', textContent: 'Show', onclick: () => chrome.downloads.show(job.files[0].downloadId) }));
  }
  return el('li', { className: `job${child ? ' child' : ''}` }, [
    el('div', { className: 'top' }, [el('span', { className: 'name', textContent: name, title: name }), el('span', { className: `state ${job.state}`, textContent: text }), ...actions]),
    pct !== null ? el('div', { className: 'bar' }, [el('div', { style: `width:${pct}%` })]) : null,
    job.error ? el('div', { className: 'error', textContent: job.error }) : null,
    ...(job.notes || []).map((n) => el('div', { className: 'note', textContent: n })),
  ]);
}

async function renderJobs() {
  const { jobs = {} } = await chrome.storage.session.get('jobs');
  const all = Object.values(jobs).sort((a, b) => b.created - a.created);
  const rows = [];
  for (const j of all.filter((x) => !x.parent)) {
    rows.push(jobRow(j, false));
    // A playlist's videos: the active ones and the last few that ended.
    const kids = all.filter((x) => x.parent === j.id).sort((a, b) => a.playlist.index - b.playlist.index);
    const shown = kids.filter((k) => ACTIVE.includes(k.state) && k.state !== 'queued').concat(kids.filter((k) => k.state === 'failed'));
    for (const k of shown.slice(0, 5)) rows.push(jobRow(k, true));
  }
  $('jobs').replaceChildren(...rows);
  $('noJobs').classList.toggle('hidden', rows.length > 0);
  $('clear').classList.toggle('hidden', !all.some((j) => !ACTIVE.includes(j.state)));
}

$('clear').onclick = () => send('clear');
chrome.storage.onChanged.addListener((changes, area) => area === 'session' && changes.jobs && renderJobs());
setInterval(() => document.querySelector('.state') && renderJobs(), 1000); // pause countdowns

// ---------- options ----------

function showOptions(on) {
  $('view-main').classList.toggle('hidden', on);
  $('view-options').classList.toggle('hidden', !on);
  $('back').classList.toggle('hidden', !on);
  $('gear').classList.toggle('hidden', on);
  $('heading').textContent = on ? 'Options' : 'yt-dlp Downloader';
}

function wireOptions() {
  const s = state.settings;
  const bind = (id, key, read, write = (v) => v) => {
    const input = $(id);
    if (input.type === 'checkbox') input.checked = write(s[key]);
    else input.value = write(s[key]);
    input.onchange = () => {
      s[key] = read(input);
      saveSettings(s);
    };
  };
  bind('optQuality', 'maxHeight', (i) => Number(i.value), String);
  bind('optCompatible', 'compatible', (i) => i.checked);
  bind('optSubtitles', 'subtitles', (i) => i.checked);
  bind('optLogin', 'login', (i) => i.value);
  const seconds = (i) => Math.max(0, Number(i.value) || 0);
  bind('optSleepMin', 'sleepMin', seconds);
  bind('optSleepRandom', 'sleepRandom', seconds);
  bind('optSleepRequests', 'sleepRequests', seconds);
  bind('optSleepSubtitles', 'sleepSubtitles', seconds);
}

// ---------- logins from another browser ----------

async function showImported() {
  const { imported } = await send('importedCookies');
  const line = $('importedNow');
  line.replaceChildren();
  if (!imported) {
    line.textContent = 'Not set: this browser’s own logins are used.';
    return;
  }
  const yt = imported.domains.some((d) => /(^|\.)youtube\.com$/.test(d));
  line.append(
    `Using ${imported.count} cookies from ${BROWSERS[imported.from]?.name || imported.from}${yt ? ' (YouTube included)' : ''}. `,
    el('button', { className: 'link', textContent: 'Remove', onclick: async () => (await send('removeCookies'), showImported()) })
  );
}

function showHints() {
  const { paths, notes } = hintsFor($('impBrowser').value, $('impSystem').value);
  $('impPaths').replaceChildren(...paths.map((p) => el('li', { textContent: p })));
  $('impNotes').replaceChildren(...notes.map((n) => el('li', { textContent: n })));
  $('impFile').accept = $('impBrowser').value === 'txt' ? '.txt' : '';
}

function wireImport() {
  $('impBrowser').replaceChildren(...Object.entries(BROWSERS).map(([v, b]) => el('option', { value: v, textContent: b.name })));
  $('impSystem').replaceChildren(...Object.entries(SYSTEMS).map(([v, name]) => el('option', { value: v, textContent: name })));
  $('impSystem').value = detectSystem();
  $('impBrowser').onchange = $('impSystem').onchange = showHints;
  showHints();
  $('impFile').onchange = async () => {
    const picked = [...$('impFile').files];
    if (!picked.length) return;
    const result = $('impResult');
    result.className = 'small muted';
    result.textContent = 'Reading the cookies…';
    try {
      const files = await Promise.all(picked.map(async (f) => {
        const bytes = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { name: f.name, data: btoa(bin) };
      }));
      const { imported } = await send('importCookies', { kind: $('impBrowser').value, files });
      result.className = 'small ok';
      result.textContent = `Imported ${imported.count} cookies.`;
    } catch (e) {
      result.className = 'small bad';
      result.textContent = e.message;
    } finally {
      $('impFile').value = '';
      showImported();
    }
  };
  showImported();
}

$('gear').onclick = async () => {
  showOptions(true);
  send('versions')
    .then((v) => ($('versions').textContent = `yt-dlp ${v['yt-dlp']} · solver ${v['yt-dlp-ejs']} · Pyodide ${v.pyodide}`))
    .catch(() => {});
};
$('back').onclick = () => showOptions(false);

(async () => {
  state.settings = await loadSettings();
  wireOptions();
  wireImport();
  renderJobs();
  analyze();
})();
