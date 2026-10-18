// The popup: analyzes the current tab with yt-dlp, offers the download, and
// lists the downloads. Everything is shown with textContent (no HTML from pages).
import { loadSettings, saveSettings, DEFAULTS } from './settings.js';
import { NAME_FIELDS, fileName } from './engine/names.js';
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

const state = { url: '', tabId: null, windowId: null, view: 'main', busy: false, summary: null, playlist: null, scope: null, mode: 'video', settings: null, subs: [] };

const formatDuration = (s) => {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
};
const formatSize = (n) => (!n ? '' : n < 1 << 20 ? `${Math.round(n / 1024)} KB` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${(n / (1 << 30)).toFixed(2)} GB`);

// ---------- the current tab ----------

// The popup's own choices become the defaults for next time (and show in Options).
function remember(key, value, optionId) {
  state.settings[key] = value;
  if (optionId) $(optionId).value = value;
  saveSettings(state.settings);
}

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
  const video = mode === 'video';
  // Audio swaps quality for the file format in the same place, so nothing moves.
  $('quality').classList.toggle('hidden', !video);
  $('format').classList.toggle('hidden', video);
  // Subtitles are for video only: in Audio the row stays, disabled, so nothing moves.
  showSubs();
  // The format help is about audio's formats.
  $('help').classList.toggle('hidden', video);
}

// The controls, usable only once there's something to download.
function setReady(ready) {
  for (const c of $('found').querySelectorAll('button, select, input')) c.disabled = !ready;
}

// No video (yet): the same menu, empty and disabled, so the popup keeps its size.
function showWaiting(text) {
  $('title').textContent = text;
  $('sub').textContent = '';
  $('status').classList.add('hidden');
  $('thumb').removeAttribute('src');
  $('thumb').classList.add('empty');
  $('quality').replaceChildren(el('option', { value: '0', textContent: 'Best' }));
  state.subs = [];
  $('format').value = state.settings.audioFormat || 'm4a';
  setMode(state.settings.mode === 'music' ? 'music' : 'video');
  setReady(false);
}

function showSummary() {
  const s = state.summary;
  // A video in a playlist, the whole list chosen: the menu shows the list, with the video's picture.
  const list = state.scope === 'playlist' ? state.playlist : s.kind === 'playlist' ? s : null;
  $('status').classList.add('hidden');
  $('title').textContent = (list || s).title || state.url;
  // Without a picture its place stays, in grey (the img's background), so nothing moves.
  $('thumb').classList.toggle('empty', !s.thumbnail);
  if (list) {
    if (s.thumbnail) $('thumb').src = s.thumbnail;
    else $('thumb').removeAttribute('src');
    $('sub').textContent = [list.uploader, `${list.count} videos`].filter(Boolean).join(' · ');
  } else {
    if (s.thumbnail) $('thumb').src = s.thumbnail;
    else $('thumb').removeAttribute('src');
    $('sub').textContent = [s.uploader, s.live ? 'live' : s.duration ? formatDuration(s.duration) : '', s.extractor !== 'Youtube' ? s.extractor : ''].filter(Boolean).join(' · ');
  }

  const heights = s.heights || [];
  $('quality').replaceChildren(
    el('option', { value: '0', textContent: heights[0] ? `Best (${heights[0]}p)` : 'Best' }),
    ...heights.filter((h) => h >= 240).map((h) => el('option', { value: String(h), textContent: `${h}p` }))
  );
  // The highest quality up to the cap in the options (1080p by default), else the best.
  const cap = state.settings.maxHeight;
  $('quality').value = String((cap && heights.find((h) => h >= 240 && h <= cap)) || 0);
  // Subtitles: a list of languages, empty to start with.
  state.subs = [];
  $('format').value = state.settings.audioFormat || 'm4a';
  const mode = state.settings.mode === 'auto' ? (s.music ? 'music' : 'video') : state.settings.mode;
  setMode(mode);
  setReady(true);
  showSubs(); // after setReady: the menu stays disabled when every language is added
}

// The chosen subtitles as chips, and the menu offering the rest.
const SUB_GROUPS = { creator: 'Subtitles', auto: 'Automatic captions', translated: 'Auto-translated' };
function showSubs() {
  const options = state.summary?.subtitles?.options || [];
  const usable = !!state.summary && state.mode === 'video';
  const chosen = state.subs.map((id) => options.find((o) => o.id === id)).filter(Boolean);
  $('subsList').replaceChildren(
    ...chosen.map((o) =>
      el('span', { className: 'chip' }, [
        el('span', { textContent: o.name, title: o.name }),
        el('button', { textContent: '×', title: `Remove ${o.name}`, ariaLabel: `Remove ${o.name}`, disabled: !usable, onclick: () => ((state.subs = state.subs.filter((id) => id !== o.id)), showSubs()) }),
      ])
    )
  );
  const left = options.filter((o) => !state.subs.includes(o.id));
  $('subs').replaceChildren(
    // A placeholder, not a choice: an empty list is "no subtitles".
    el('option', { value: '', textContent: left.length || !state.summary ? 'Add subtitles' : options.length ? 'All added' : 'No subtitles', hidden: true, selected: true }),
    ...Object.entries(SUB_GROUPS)
      .map(([group, label]) => [label, left.filter((o) => o.group === group)])
      .filter(([, list]) => list.length)
      .map(([label, list]) => el('optgroup', { label }, list.map((o) => el('option', { value: o.id, textContent: o.name }))))
  );
  $('subs').disabled = !usable || !left.length;
}

$('subs').onchange = () => {
  if ($('subs').value) state.subs.push($('subs').value);
  showSubs();
};

// Each analysis replaces the one before: a late answer for an old page is dropped.
let analysis = 0;
async function analyze(url) {
  const run = ++analysis;
  state.url = url;
  state.summary = state.playlist = state.scope = null;
  layout();
  if (!/^https?:/.test(url)) return showWaiting('Open a page with a video to download it.');
  // Read already, as the page opened (see detect in background.js): the menu right away.
  const { detected = {} } = await chrome.storage.session.get('detected');
  if (run !== analysis) return;
  const known = detected[state.tabId];
  if (known?.url === url) {
    state.summary = known.summary;
    state.playlist = known.playlist;
    $('pickCount').textContent = state.playlist ? `(${state.playlist.count})` : '';
    showSummary();
    return layout();
  }
  showWaiting('Reading this page…');
  try {
    const { summary } = await send('analyze', { url });
    if (run !== analysis) return;
    state.summary = summary;
    // A video in a playlist: learn the playlist too (fast, flat listing), to ask
    // which of the two to download. Not for YouTube Mixes (list=RD…): they're
    // endless radio lists, not playlists.
    const list = new URL(state.url).searchParams.get('list') || '';
    if (summary.kind === 'video' && list && !list.startsWith('RD')) {
      const p = await send('analyze', { url, playlist: true }).then((r) => r.summary, () => null);
      if (run !== analysis) return;
      if (p?.kind === 'playlist') state.playlist = p;
    }
    $('pickCount').textContent = state.playlist ? `(${state.playlist.count})` : '';
    showSummary();
    layout();
  } catch (e) {
    if (run === analysis) showWaiting(/Unsupported URL/i.test(e.message) ? 'No video yt-dlp can download on this page.' : e.message);
  }
}

// The page can change with the popup open (a click on another video): read it again.
chrome.tabs.onUpdated.addListener((id, change) => id === state.tabId && change.url && change.url !== state.url && analyze(change.url));
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (windowId !== state.windowId) return;
  state.tabId = tabId;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tab.url !== state.url) analyze(tab.url || '');
});

$('modeVideo').onclick = () => (setMode('video'), remember('mode', 'video'));
$('modeMusic').onclick = () => (setMode('music'), remember('mode', 'music'));
$('format').onchange = () => remember('audioFormat', $('format').value, 'optFormat');
$('help').onclick = () => showView('formats');

$('go').onclick = async () => {
  $('go').disabled = true;
  try {
    const playlist = state.summary.kind === 'playlist' || state.scope === 'playlist';
    // This download's choices (quality, subtitles) without changing the defaults.
    const overrides = { maxHeight: Number($('quality').value) || 0, subtitleTracks: [...state.subs], audioFormat: $('format').value };
    await send('download', { url: state.url, mode: state.mode, playlist, title: playlist ? (state.playlist || state.summary).title : state.summary.title, overrides });
  } catch (e) {
    $('status').textContent = e.message;
    $('status').classList.remove('hidden');
  } finally {
    setTimeout(() => ($('go').disabled = !state.summary), 800);
  }
};

// The main view shows one thing: a download on its way, the video-or-playlist
// question, or the download menu. The back arrow goes from the menu to the question.
function layout() {
  const ask = !state.busy && !!state.playlist && !state.scope;
  $('jobs').classList.toggle('hidden', !state.busy);
  $('choose').classList.toggle('hidden', !ask);
  $('card').classList.toggle('hidden', state.busy || ask);
  $('back').classList.toggle('hidden', state.view === 'main' && (state.busy || ask || !state.playlist));
}

function pick(scope) {
  state.scope = scope;
  showSummary();
  layout();
}
$('pickVideo').onclick = () => pick('video');
$('pickList').onclick = () => pick('playlist');

// The popup is as tall as the download menu; the other views take that height too.
new ResizeObserver(() => {
  const menu = $('card').offsetHeight;
  if (menu) document.body.style.height = `${$('heading').closest('header').offsetHeight + 24 + menu}px`; // 24: main's padding
}).observe($('card'));

// ---------- downloads ----------

const STATE_TEXT = {
  queued: 'Waiting',
  extracting: 'Reading the video…',
  downloading: 'Downloading',
  writing: 'Putting the file together…',
  converting: 'Converting',
  saving: 'Saving…',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  expanded: 'Playlist',
};
const ACTIVE = ['queued', 'extracting', 'downloading', 'writing', 'converting', 'saving', 'waiting', 'expanded'];

// Download speed per job, from the bytes reported between renders (smoothed).
const speeds = new Map(); // id -> { bytes, at, rate }
function speedOf(job) {
  const now = Date.now();
  const last = speeds.get(job.id);
  const bytes = job.progress.bytes;
  if (!last || bytes < last.bytes) return speeds.set(job.id, { bytes, at: now, rate: 0 }), 0;
  if (now - last.at >= 700) {
    const rate = ((bytes - last.bytes) / (now - last.at)) * 1000;
    speeds.set(job.id, { bytes, at: now, rate: last.rate ? last.rate * 0.6 + rate * 0.4 : rate });
  }
  return speeds.get(job.id).rate;
}

// What a job is doing, in words, and how far along it is (null: unknown).
function describe(job) {
  let text = STATE_TEXT[job.state] || job.state;
  let detail = '';
  let pct = null;
  if (job.state === 'waiting') text = `Pausing ${Math.max(0, Math.ceil((job.until - Date.now()) / 1000))} s before the next one`;
  if (job.state === 'downloading' && job.progress) {
    const { bytes, total, part, parts } = job.progress;
    pct = total ? Math.min(100, (bytes / total) * 100) : null;
    const rate = speedOf(job);
    text = `Downloading${parts > 1 ? ` ${part} of ${parts}` : ''}`;
    detail = [total ? `${formatSize(bytes) || '0 KB'} of ${formatSize(total)}` : formatSize(bytes), rate ? `${formatSize(rate)}/s` : ''].filter(Boolean).join(' · ');
  }
  if (job.state === 'converting' && job.progress) {
    text = `Converting to ${(job.format || '').toUpperCase()}…`;
    pct = job.progress.total ? Math.min(100, (job.progress.done / job.progress.total) * 100) : null;
  }
  if (job.state === 'expanded' && job.progress) {
    const { done, count, failed } = job.progress;
    text = `Playlist · ${done} of ${count} done${failed ? ` · ${failed} failed` : ''}`;
    pct = (done / count) * 100;
  }
  return { text, detail, pct };
}

// A bar that moves on its own until there's a percentage. The view is redrawn on
// every update: the busy animation is timed off the clock so it doesn't restart.
const bar = (pct, className = 'bar') => {
  const fill = pct === null ? `animation-delay:-${(Date.now() % 1200) / 1000}s` : `width:${pct}%`;
  return el('div', { className: `${className}${pct === null ? ' busy' : ''}` }, [el('div', { style: fill })]);
};
const extras = (job) => [
  job.error ? el('div', { className: 'error', textContent: job.error }) : null,
  ...(job.notes || []).map((n) => el('div', { className: 'note', textContent: n })),
];

// A ring around the percentage (or a count); it spins while there's no percentage
// yet, timed off the clock like the bars so a redraw doesn't restart it.
const ring = (pct, label) => {
  const spin = pct === null ? `animation-delay:-${(Date.now() % 1200) / 1000}s;` : '';
  return el('div', { className: `ring${pct === null ? ' busy' : ''}`, style: `${spin}--p:${pct ?? 25}` }, [el('span', { textContent: label, style: spin })]);
};

// A download, filling the popup: a ring with how far it is, and next to it what
// it is and what it's doing. For a playlist the ring counts the videos, and the
// video on its way shows under it.
function task(job, kids) {
  const { text, detail, pct } = describe(job);
  // Before yt-dlp has the title, the site it's on.
  const name = job.title || URL.parse(job.url)?.hostname || job.url;
  const playlist = job.state === 'expanded';
  const label = playlist ? `${job.progress?.done ?? 0}/${job.progress?.count ?? '?'}` : pct === null ? '' : `${Math.floor(pct)}%`;
  const current = kids.find((k) => ACTIVE.includes(k.state) && k.state !== 'queued');
  let video = null;
  if (current) {
    const d = describe(current);
    const title = `${current.playlist.index}. ${current.title || current.url}`;
    video = el('div', { className: 'current' }, [
      el('div', { className: 'top' }, [
        el('span', { className: 'name', textContent: title, title }),
        d.pct !== null ? el('span', { className: 'pct', textContent: `${Math.floor(d.pct)}%` }) : null,
      ]),
      bar(d.pct),
      el('div', { className: 'status' }, [
        el('span', { className: 'detail', textContent: [d.text, d.detail].filter(Boolean).join(' · ') }),
        el('button', { className: 'link', textContent: 'Skip', title: 'Skip this video', onclick: () => send('cancel', { id: current.id }) }),
      ]),
      ...extras(current),
    ]);
  }
  // The cancel button keeps its place at the bottom while what's above it changes.
  return el('div', { className: 'task' }, [
    el('div', { className: 'body' }, [
      el('div', { className: 'head' }, [
        ring(pct, label),
        el('div', { className: 'info' }, [
          el('div', { className: 'name', textContent: name, title: name }),
          el('div', { className: 'state', textContent: playlist ? text.replace(/^Playlist · /, '') : text }),
          el('div', { className: 'detail', textContent: detail }),
        ]),
      ]),
      video,
      ...extras(job),
    ]),
    el('button', { className: 'secondary', textContent: playlist ? 'Cancel playlist' : 'Cancel', onclick: () => send('cancel', { id: job.id }) }),
  ]);
}

async function renderJobs() {
  const { jobs = {} } = await chrome.storage.session.get('jobs');
  const all = Object.values(jobs).sort((a, b) => b.created - a.created);
  // Only what's still going: a finished download disappears.
  const tasks = all
    .filter((x) => !x.parent && ACTIVE.includes(x.state))
    .map((j) => task(j, all.filter((x) => x.parent === j.id).sort((a, b) => a.playlist.index - b.playlist.index)));
  $('jobs').replaceChildren(...tasks);
  // While something downloads, its progress takes the menu's place; then the menu is back.
  state.busy = tasks.length > 0;
  layout();
}
chrome.storage.onChanged.addListener((changes, area) => area === 'session' && changes.jobs && renderJobs());
setInterval(() => document.querySelector('#jobs .task') && renderJobs(), 1000); // countdowns and speeds

// ---------- options ----------

const VIEWS = { main: 'yt-dlp-extension', options: 'Options', formats: 'Which format?' };
function showView(view) {
  state.view = view;
  for (const v of Object.keys(VIEWS)) $(`view-${v}`).classList.toggle('hidden', v !== view);
  layout();
  $('gear').classList.toggle('hidden', view !== 'main');
  $('heading').textContent = VIEWS[view];
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
  bind('optFormat', 'audioFormat', (i) => ($('format').value = i.value));
  bind('optNumber', 'numberPlaylist', (i) => (showNames(), i.checked));
  bind('optUnderscores', 'underscores', (i) => (showNames(), i.checked));
  // An emptied template goes back to the default.
  bind('optNameVideo', 'nameVideo', (i) => (i.value = i.value.trim() || DEFAULTS.nameVideo));
  bind('optNameAudio', 'nameAudio', (i) => (i.value = i.value.trim() || DEFAULTS.nameAudio));
  wireNames();
  bind('optCompatible', 'compatible', (i) => i.checked);
  for (const key of ['metaDetails', 'metaDescription', 'metaLink', 'metaCover', 'metaChapters']) bind(`opt${key[0].toUpperCase()}${key.slice(1)}`, key, (i) => i.checked);
  const seconds = (i) => Math.max(0, Number(i.value) || 0);
  bind('optSleepMin', 'sleepMin', seconds);
  bind('optSleepRandom', 'sleepRandom', seconds);
  bind('optSleepRequests', 'sleepRequests', seconds);
  bind('optSleepSubtitles', 'sleepSubtitles', seconds);
}

// ---------- file names ----------

const SAMPLE = { title: 'Me at the zoo', channel: 'jawed', artist: 'jawed', track: 'Me at the zoo', date: '2005-04-23', id: 'jNQXAC9IVRw' };

// What the templates give, for a sample video.
function showNames() {
  const opts = { underscores: $('optUnderscores').checked, number: $('optNumber').checked ? '01' : '' };
  const audio = { m4a: 'm4a', mp3: 'mp3', opus: 'webm', wav: 'wav' }[$('optFormat').value] || 'm4a';
  $('namePreview').replaceChildren(
    el('div', { textContent: `Video: ${fileName($('optNameVideo').value, SAMPLE, opts)}.mp4` }),
    el('div', { textContent: `Audio: ${fileName($('optNameAudio').value, SAMPLE, opts)}.${audio}` })
  );
}

// The field buttons add {field} where the cursor was, in the template last used.
function wireNames() {
  let target = $('optNameVideo');
  for (const id of ['optNameVideo', 'optNameAudio']) {
    $(id).addEventListener('focus', () => (target = $(id)));
    $(id).addEventListener('input', showNames);
  }
  $('optFormat').addEventListener('change', showNames);
  $('nameFields').replaceChildren(
    ...Object.entries(NAME_FIELDS).map(([field, about]) =>
      el('button', {
        type: 'button',
        textContent: `{${field}}`,
        title: `Add ${about}`,
        onmousedown: (e) => e.preventDefault(), // keep the cursor in the template
        onclick: () => {
          const { selectionStart: a, selectionEnd: z, value } = target;
          target.value = value.slice(0, a) + `{${field}}` + value.slice(z);
          target.setSelectionRange(a + field.length + 2, a + field.length + 2);
          target.focus();
          target.dispatchEvent(new Event('change'));
          showNames();
        },
      })
    )
  );
  showNames();
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
  showView('options');
  send('versions')
    .then((v) => ($('versions').textContent = `yt-dlp ${v['yt-dlp']} · solver ${v['yt-dlp-ejs']} · Pyodide ${v.pyodide}`))
    .catch(() => {});
};
$('back').onclick = () => (state.view === 'main' ? ((state.scope = null), layout()) : showView('main'));

(async () => {
  state.settings = await loadSettings();
  wireOptions();
  wireImport();
  renderJobs();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id ?? null;
  state.windowId = tab?.windowId ?? null;
  analyze(tab?.url || '');
})();
