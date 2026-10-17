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

const state = { url: '', summary: null, playlist: null, mode: 'video', settings: null, subs: [] };

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
  // Subtitles are for video only: in Audio the row goes and the popup shrinks.
  $('subsRow').classList.toggle('hidden', !video || !state.summary?.subtitles?.options.length);
  // The format help is about audio's formats.
  $('help').classList.toggle('hidden', video);
}

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
  // The highest quality up to the cap in the options (1080p by default), else the best.
  const cap = state.settings.maxHeight;
  $('quality').value = String((cap && heights.find((h) => h >= 240 && h <= cap)) || 0);
  // Subtitles: a list of languages, empty to start with.
  state.subs = [];
  showSubs();
  $('format').value = state.settings.audioFormat || 'm4a';
  const mode = state.settings.mode === 'auto' ? (s.music ? 'music' : 'video') : state.settings.mode;
  setMode(mode);
}

// The chosen subtitles as chips, and the menu offering the rest.
const SUB_GROUPS = { creator: 'Subtitles', auto: 'Automatic captions', translated: 'Auto-translated' };
function showSubs() {
  const options = state.summary?.subtitles?.options || [];
  const chosen = state.subs.map((id) => options.find((o) => o.id === id)).filter(Boolean);
  $('subsList').replaceChildren(
    ...chosen.map((o) =>
      el('span', { className: 'chip' }, [
        el('span', { textContent: o.name, title: o.name }),
        el('button', { textContent: '×', title: `Remove ${o.name}`, ariaLabel: `Remove ${o.name}`, onclick: () => ((state.subs = state.subs.filter((id) => id !== o.id)), showSubs()) }),
      ])
    )
  );
  const left = options.filter((o) => !state.subs.includes(o.id));
  $('subs').replaceChildren(
    // A placeholder, not a choice: an empty list is "no subtitles".
    el('option', { value: '', textContent: left.length ? 'Add subtitles' : 'All added', hidden: true, selected: true }),
    ...Object.entries(SUB_GROUPS)
      .map(([group, label]) => [label, left.filter((o) => o.group === group)])
      .filter(([, list]) => list.length)
      .map(([label, list]) => el('optgroup', { label }, list.map((o) => el('option', { value: o.id, textContent: o.name }))))
  );
  $('subs').disabled = !left.length;
}

$('subs').onchange = () => {
  if ($('subs').value) state.subs.push($('subs').value);
  showSubs();
};

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
    // Not for YouTube Mixes (list=RD…): they're endless radio lists, not playlists.
    const list = new URL(state.url).searchParams.get('list') || '';
    if (summary.kind === 'video' && list && !list.startsWith('RD')) {
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

$('modeVideo').onclick = () => (setMode('video'), remember('mode', 'video'));
$('modeMusic').onclick = () => (setMode('music'), remember('mode', 'music'));
$('format').onchange = () => remember('audioFormat', $('format').value, 'optFormat');
$('help').onclick = () => showView('formats');

$('go').onclick = async () => {
  $('go').disabled = true;
  try {
    const playlist = state.summary.kind === 'playlist' || document.querySelector('input[name=scope]:checked')?.value === 'playlist';
    // This download's choices (quality, subtitles) without changing the defaults.
    const overrides = { maxHeight: Number($('quality').value) || 0, subtitleTracks: [...state.subs], audioFormat: $('format').value };
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

function jobRow(job, child) {
  let text = STATE_TEXT[job.state] || job.state;
  let detail = '';
  let pct = null;
  if (job.state === 'waiting') text = `Pausing ${Math.max(0, Math.ceil((job.until - Date.now()) / 1000))} s (playlist)`;
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
    text = `Playlist · ${job.progress.done} of ${job.progress.count}${job.progress.failed ? ` · ${job.progress.failed} failed` : ''}`;
    pct = (job.progress.done / job.progress.count) * 100;
  }
  const active = ACTIVE.includes(job.state);
  const name = (job.playlist ? `${job.playlist.index}. ` : '') + (job.title || job.url);
  const actions = [];
  if (active && !(child && job.state === 'expanded')) {
    actions.push(el('button', { className: 'link', textContent: 'Cancel', onclick: () => send('cancel', { id: job.id }) }));
  }
  if (job.state === 'done' && job.files?.[0]?.downloadId) {
    actions.push(el('button', { className: 'link', textContent: 'Show', onclick: () => chrome.downloads.show(job.files[0].downloadId) }));
  }
  // Active jobs always have a bar: it moves on its own until there's a percentage.
  // The list is redrawn on every update: the busy animation is timed off the clock so it doesn't restart.
  const fill = pct === null ? `animation-delay:-${(Date.now() % 1200) / 1000}s` : `width:${pct}%`;
  const bar = active ? el('div', { className: `bar${pct === null ? ' busy' : ''}` }, [el('div', { style: fill })]) : null;
  return el('li', { className: `job${child ? ' child' : ''}` }, [
    el('div', { className: 'top' }, [el('span', { className: 'name', textContent: name, title: name }), ...actions]),
    bar,
    el('div', { className: 'status' }, [
      el('span', { className: `state ${job.state}`, textContent: text }),
      el('span', { className: 'detail', textContent: detail }),
      pct !== null && active ? el('span', { className: 'pct', textContent: `${Math.floor(pct)}%` }) : null,
    ]),
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
  $('downloads').classList.toggle('hidden', rows.length === 0);
  $('clear').classList.toggle('hidden', !all.some((j) => !ACTIVE.includes(j.state)));
}

$('clear').onclick = () => send('clear');
chrome.storage.onChanged.addListener((changes, area) => area === 'session' && changes.jobs && renderJobs());
setInterval(() => document.querySelector('#jobs .bar') && renderJobs(), 1000); // countdowns and speeds

// ---------- options ----------

const VIEWS = { main: 'yt-dlp-chrome', options: 'Options', formats: 'Which format?' };
function showView(view) {
  for (const v of Object.keys(VIEWS)) $(`view-${v}`).classList.toggle('hidden', v !== view);
  $('back').classList.toggle('hidden', view === 'main');
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
$('back').onclick = () => showView('main');

(async () => {
  state.settings = await loadSettings();
  wireOptions();
  wireImport();
  renderJobs();
  analyze();
})();
