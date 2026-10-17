// Subtitles: choosing which tracks and formats to fetch, and turning them into
// cues [{ start, end, text }] (seconds) for the MP4 writer.

// Formats we can read, best first. YouTube's json3 has clean timing even for
// automatic captions, whose WebVTT repeats each line as it scrolls.
const READABLE = ['json3', 'vtt', 'srt'];

// The format to fetch for one track: [{ ext, url, name }] -> one of them, or null.
export function pickFormat(formats = []) {
  for (const ext of READABLE) {
    const f = formats.find((x) => x.ext === ext && x.url);
    if (f) return f;
  }
  return null;
}

const base = (l) => l.replace(/-orig$/, '');
const short = (l) => base(l).split('-')[0];
const autoName = (name, lang) => `${(name || lang).replace(/ \(Original\)$/, '')} (auto)`;

// The automatic captions in the video's own language: "<lang>-orig" is what was
// spoken in each audio track (dubbed videos have several), so the one matching
// info.language comes first. Null when there are none.
export function originalAuto(info) {
  const keys = Object.keys(info.automatic_captions || {});
  const lang = info.language || '';
  const same = (l) => lang && (base(l) === lang || short(l) === short(lang));
  return keys.find((l) => l.endsWith('-orig') && same(l)) || keys.find(same) || keys.find((l) => l.endsWith('-orig')) || null;
}

// Every subtitle a video offers, for the popup's menu: [{ id, name, group }],
// where group is 'creator' (uploaded), 'auto' (automatic, as spoken) or
// 'translated' (YouTube's machine translations). The id is what chooseTracks takes.
export function subtitleOptions(info) {
  const out = [];
  for (const [lang, formats] of Object.entries(info.subtitles || {})) {
    if (lang !== 'live_chat' && pickFormat(formats)) out.push({ id: `c:${lang}`, name: formats.find((f) => f.name)?.name || lang, group: 'creator' });
  }
  const auto = info.automatic_captions || {};
  const original = originalAuto(info);
  const spoken = Object.keys(auto).filter((l) => (l.endsWith('-orig') || l === original) && pickFormat(auto[l]));
  spoken.sort((x, y) => (y === original) - (x === original));
  for (const l of spoken) out.push({ id: `a:${l}`, name: autoName(auto[l][0]?.name, base(l)), group: 'auto' });
  const said = new Set(spoken.map(short));
  const translated = Object.entries(auto)
    .filter(([l, formats]) => !l.endsWith('-orig') && l !== original && !said.has(short(l)) && pickFormat(formats))
    .map(([l, formats]) => ({ id: `a:${l}`, name: formats[0]?.name || l, group: 'translated' }));
  return out.concat(translated.sort((x, y) => x.name.localeCompare(y.name)));
}

// Which tracks to embed. With `picks` (ids from subtitleOptions), those the video
// has, in that order. Otherwise every subtitle the creator uploaded, plus the
// automatic captions in the video's own language (not the machine translations).
// Returns [{ lang, auto, name, format }], the creator's first.
export function chooseTracks(info, picks = null) {
  const auto = info.automatic_captions || {};
  const picked = [];
  for (const pick of picks ? [picks].flat() : []) {
    const [kind, lang] = [pick.slice(0, 1), pick.slice(2)];
    const formats = kind === 'c' ? info.subtitles?.[lang] : auto[lang];
    const format = pickFormat(formats);
    if (format) picked.push({ lang: base(lang), auto: kind === 'a', name: kind === 'a' ? autoName(format.name, base(lang)) : format.name || lang, format });
  }
  if (picked.length) return picked;
  const out = [];
  for (const [lang, formats] of Object.entries(info.subtitles || {})) {
    if (lang === 'live_chat') continue;
    const format = pickFormat(formats);
    if (format) out.push({ lang, auto: false, name: format.name || lang, format });
  }
  const original = originalAuto(info);
  if (original && !out.some((t) => t.lang === base(original))) {
    const format = pickFormat(auto[original]);
    if (format) out.push({ lang: base(original), auto: true, name: autoName(format.name, base(original)), format });
  }
  return out;
}

const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[e] ?? String.fromCharCode(Number(e.slice(1))));
const clean = (text) => decode(text.replace(/<[^>]*>/g, '')).replace(/[ \t]+\n/g, '\n').trim();

// "01:02:03.456", "02:03.456" or "00:00:01,000" -> seconds.
const seconds = (t) => t.replace(',', '.').split(':').reduce((n, x) => n * 60 + Number(x), 0);

// WebVTT and SRT. YouTube's automatic WebVTT repeats the previous line in each
// cue as the text scrolls up: those repeats are dropped.
export function parseVtt(text) {
  const cues = [];
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const m = lines[i].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
    if (!m) continue;
    const body = clean(lines.slice(i + 1).join('\n'));
    if (body) cues.push({ start: seconds(m[1]), end: seconds(m[2]), text: body });
  }
  // Scrolling captions: keep only the lines a cue adds to the one before it.
  for (let k = 1; k < cues.length; k++) {
    const prev = cues[k - 1].text.split('\n');
    const lines = cues[k].text.split('\n');
    while (lines.length > 1 && prev.includes(lines[0])) lines.shift();
    cues[k].text = lines.join('\n');
  }
  return cues.filter((c, k) => c.end - c.start > 0.02 && !(k && c.text === cues[k - 1].text && c.start <= cues[k - 1].end + 0.02));
}

// YouTube's json3: { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }.
export function parseJson3(text) {
  const { events = [] } = JSON.parse(text);
  const cues = [];
  for (const e of events) {
    if (!e.segs || e.dDurationMs === undefined) continue;
    const body = e.segs.map((s) => s.utf8 || '').join('').trim();
    if (!body || body === '\n') continue;
    cues.push({ start: e.tStartMs / 1000, end: (e.tStartMs + e.dDurationMs) / 1000, text: body });
  }
  // Automatic captions overlap (a line stays while the next appears): end each at the next's start.
  for (let k = 0; k + 1 < cues.length; k++) if (cues[k].end > cues[k + 1].start) cues[k].end = cues[k + 1].start;
  return cues.filter((c) => c.end > c.start);
}

export function parseSubtitles(text, ext) {
  if (ext === 'json3') return parseJson3(text);
  return parseVtt(text); // vtt and srt share the cue syntax
}
