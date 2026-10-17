// Reads the samples of MP4 tracks (fragmented or not) and writes standard MP4
// files: video, audio, subtitles (mov_text), chapters, metadata and cover art,
// with the index (moov) first. Media data is never copied: the output Blob is
// made of slices of the input files. Pure logic, no UI, so it runs in tests.
import { boxes, findAll, indexBlob, box } from '../lib/fmp4.js';

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const fourcc = (b, at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const child = (bytes, parent, type) => boxes(bytes, parent.body, parent.end).find((b) => b.type === type);
const childPath = (bytes, parent, path) => path.reduce((p, t) => p && child(bytes, p, t), parent);
const raw = (bytes, b) => bytes.slice(b.start, b.end);

// ---------- reading ----------

async function read(blob, offset, size) {
  return new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
}

// The tracks of an MP4 file and all their samples:
// [{ id, kind ('vide'|'soun'|…), timescale, language, stsd, edits, width, height,
//    start (seconds), samples: [{ offset, size, duration, cto, sync }] }].
// `index` (the file's top-level boxes) is read from the file when not given.
export async function readTracks(blob, index = null) {
  index ||= await indexBlob(blob);
  const moovBox = index.find((b) => b.type === 'moov');
  if (!moovBox) throw new Error('Not an MP4 file (no moov).');
  const moov = await read(blob, moovBox.offset, moovBox.size);
  const root = boxes(moov)[0];
  const mv = view(moov);
  const mvhd = child(moov, root, 'mvhd');
  const movieScale = mvhd ? mv.getUint32(mvhd.body + (moov[mvhd.body] === 1 ? 20 : 12)) : 1000;
  const trex = new Map();
  for (const t of findAll(moov, ['mvex', 'trex'], root)) {
    trex.set(mv.getUint32(t.body + 4), { sdi: mv.getUint32(t.body + 8), duration: mv.getUint32(t.body + 12), size: mv.getUint32(t.body + 16), flags: mv.getUint32(t.body + 20) });
  }

  const tracks = findAll(moov, ['trak'], root).map((trak) => {
    const tkhd = child(moov, trak, 'tkhd');
    const v1 = moov[tkhd.body] === 1;
    const mdhd = childPath(moov, trak, ['mdia', 'mdhd']);
    const hdlr = childPath(moov, trak, ['mdia', 'hdlr']);
    const stbl = childPath(moov, trak, ['mdia', 'minf', 'stbl']);
    const elst = childPath(moov, trak, ['edts', 'elst']);
    const mdhdV1 = moov[mdhd.body] === 1;
    const lang = mv.getUint16(mdhd.body + (mdhdV1 ? 32 : 20));
    return {
      id: mv.getUint32(tkhd.body + (v1 ? 20 : 12)),
      kind: hdlr ? fourcc(moov, hdlr.body + 8) : '',
      timescale: mv.getUint32(mdhd.body + (mdhdV1 ? 20 : 12)),
      language: String.fromCharCode(((lang >> 10) & 31) + 0x60, ((lang >> 5) & 31) + 0x60, (lang & 31) + 0x60),
      stsd: raw(moov, child(moov, stbl, 'stsd')),
      edits: elst ? readEdits(moov, elst, movieScale) : null,
      width: mv.getUint32(tkhd.end - 8) / 65536,
      height: mv.getUint32(tkhd.end - 4) / 65536,
      start: 0,
      samples: stblSamples(moov, stbl),
      _stbl: stbl,
    };
  });

  // Fragmented: the samples are in moof/mdat pairs after the moov.
  if (index.some((b) => b.type === 'moof')) {
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const firstTime = new Map();
    for (const b of index.filter((x) => x.type === 'moof')) {
      const moof = await read(blob, b.offset, b.size);
      for (const frag of fragmentSamples(moof, b.offset, trex)) {
        const t = byId.get(frag.id);
        if (!t) continue;
        if (!firstTime.has(t.id) && frag.time !== null) firstTime.set(t.id, frag.time);
        for (const s of frag.samples) t.samples.push(s);
      }
    }
    for (const t of tracks) t.start = (firstTime.get(t.id) || 0) / t.timescale;
  }
  for (const t of tracks) delete t._stbl;
  return tracks;
}

// Edit list entries, with durations in seconds: [{ duration, mediaTime, rate }].
function readEdits(bytes, elst, movieScale) {
  const v = view(bytes);
  const v1 = bytes[elst.body] === 1;
  const count = v.getUint32(elst.body + 4);
  const out = [];
  let at = elst.body + 8;
  for (let i = 0; i < count; i++) {
    const duration = v1 ? Number(v.getBigUint64(at)) : v.getUint32(at);
    const mediaTime = v1 ? Number(v.getBigInt64(at + 8)) : v.getInt32(at + 4);
    const rate = v.getInt16(at + (v1 ? 16 : 8));
    out.push({ duration: duration / movieScale, mediaTime, rate });
    at += v1 ? 20 : 12;
  }
  return out;
}

// The samples listed in a (non-fragmented) sample table.
function stblSamples(bytes, stbl) {
  const v = view(bytes);
  const get = (t) => child(bytes, stbl, t);
  const stsz = get('stsz') || get('stz2');
  if (!stsz) return [];
  const count = v.getUint32(stsz.body + 8);
  if (!count) return [];
  const fixedSize = v.getUint32(stsz.body + 4);
  const sizes = fixedSize ? null : (i) => v.getUint32(stsz.body + 12 + i * 4);

  const durations = [];
  const stts = get('stts');
  for (let i = 0, n = v.getUint32(stts.body + 4); i < n; i++) {
    const c = v.getUint32(stts.body + 8 + i * 8);
    const d = v.getUint32(stts.body + 12 + i * 8);
    for (let k = 0; k < c; k++) durations.push(d);
  }
  const ctts = get('ctts');
  const ctos = [];
  if (ctts) {
    const signed = bytes[ctts.body] === 1;
    for (let i = 0, n = v.getUint32(ctts.body + 4); i < n; i++) {
      const c = v.getUint32(ctts.body + 8 + i * 8);
      const o = signed ? v.getInt32(ctts.body + 12 + i * 8) : v.getUint32(ctts.body + 12 + i * 8);
      for (let k = 0; k < c; k++) ctos.push(o);
    }
  }
  const stss = get('stss');
  const sync = stss ? new Set(Array.from({ length: v.getUint32(stss.body + 4) }, (_, i) => v.getUint32(stss.body + 8 + i * 4))) : null;
  const stco = get('stco');
  const co64 = get('co64');
  const chunkCount = v.getUint32((stco || co64).body + 4);
  const chunkOffset = (i) => (stco ? v.getUint32(stco.body + 8 + i * 4) : Number(v.getBigUint64(co64.body + 8 + i * 8)));
  const stsc = get('stsc');
  const runs = Array.from({ length: v.getUint32(stsc.body + 4) }, (_, i) => ({ first: v.getUint32(stsc.body + 8 + i * 12), per: v.getUint32(stsc.body + 12 + i * 12) }));

  const out = [];
  let s = 0;
  for (let c = 0; c < chunkCount && s < count; c++) {
    let r = runs.length - 1;
    while (r > 0 && runs[r].first > c + 1) r--;
    let offset = chunkOffset(c);
    for (let k = 0; k < runs[r].per && s < count; k++, s++) {
      const size = sizes ? sizes(s) : fixedSize;
      out.push({ offset, size, duration: durations[s] ?? 0, cto: ctos[s] || 0, sync: sync ? sync.has(s + 1) : true });
      offset += size;
    }
  }
  return out;
}

// The samples of one moof: [{ id, time, samples }] per track fragment.
function fragmentSamples(moof, moofOffset, trex) {
  const v = view(moof);
  const root = boxes(moof)[0];
  const out = [];
  for (const traf of boxes(moof, root.body, root.end).filter((b) => b.type === 'traf')) {
    const tfhd = child(moof, traf, 'tfhd');
    const flags = v.getUint32(tfhd.body) & 0xffffff;
    const id = v.getUint32(tfhd.body + 4);
    const d = trex.get(id) || { duration: 0, size: 0, flags: 0 };
    let at = tfhd.body + 8;
    let base = moofOffset;
    if (flags & 0x1) (base = Number(v.getBigUint64(at))), (at += 8);
    if (flags & 0x2) at += 4;
    let defDuration = d.duration;
    let defSize = d.size;
    let defFlags = d.flags;
    if (flags & 0x8) (defDuration = v.getUint32(at)), (at += 4);
    if (flags & 0x10) (defSize = v.getUint32(at)), (at += 4);
    if (flags & 0x20) (defFlags = v.getUint32(at)), (at += 4);
    const tfdt = child(moof, traf, 'tfdt');
    const time = tfdt ? (moof[tfdt.body] === 1 ? Number(v.getBigUint64(tfdt.body + 4)) : v.getUint32(tfdt.body + 4)) : null;
    const samples = [];
    let dataEnd = null;
    for (const trun of boxes(moof, traf.body, traf.end).filter((b) => b.type === 'trun')) {
      const tf = v.getUint32(trun.body) & 0xffffff;
      const signed = moof[trun.body] === 1;
      const count = v.getUint32(trun.body + 4);
      let p = trun.body + 8;
      let offset = dataEnd ?? base;
      if (tf & 0x1) (offset = base + v.getInt32(p)), (p += 4);
      let firstFlags = null;
      if (tf & 0x4) (firstFlags = v.getUint32(p)), (p += 4);
      for (let i = 0; i < count; i++) {
        const duration = tf & 0x100 ? v.getUint32((p += 4) - 4) : defDuration;
        const size = tf & 0x200 ? v.getUint32((p += 4) - 4) : defSize;
        let sflags = tf & 0x400 ? v.getUint32((p += 4) - 4) : defFlags;
        if (i === 0 && firstFlags !== null) sflags = firstFlags;
        const cto = tf & 0x800 ? (signed ? v.getInt32((p += 4) - 4) : v.getUint32((p += 4) - 4)) : 0;
        samples.push({ offset, size, duration, cto, sync: !(sflags & 0x10000) });
        offset += size;
      }
      dataEnd = offset;
    }
    out.push({ id, time, samples });
  }
  return out;
}

// ---------- writing ----------

const u8 = (...n) => Uint8Array.from(n);
const u16 = (n) => u8((n >> 8) & 255, n & 255);
const u32 = (n) => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const u64 = (n) => {
  const b = new Uint8Array(8);
  view(b).setBigUint64(0, BigInt(Math.round(n)));
  return b;
};
// Many big-endian integers in one buffer: sample tables can have more entries than
// a call takes arguments. setUint32 wraps negative numbers (ctts offsets) as int32.
const u32s = (values) => {
  const b = new Uint8Array(values.length * 4);
  const v = view(b);
  values.forEach((n, i) => v.setUint32(i * 4, n));
  return b;
};
const u64s = (values) => {
  const b = new Uint8Array(values.length * 8);
  const v = view(b);
  values.forEach((n, i) => v.setBigUint64(i * 8, BigInt(Math.round(n))));
  return b;
};
const str = (s) => new TextEncoder().encode(s);
const full = (type, version, flags, ...parts) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32);

// ISO 639-2/T codes for the languages yt-dlp names with two letters.
const LANG3 = {
  en: 'eng', es: 'spa', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', ru: 'rus', ja: 'jpn', ko: 'kor', zh: 'zho', ar: 'ara', hi: 'hin',
  nl: 'nld', sv: 'swe', no: 'nor', nb: 'nob', da: 'dan', fi: 'fin', pl: 'pol', cs: 'ces', sk: 'slk', hu: 'hun', ro: 'ron', el: 'ell',
  tr: 'tur', he: 'heb', iw: 'heb', uk: 'ukr', bg: 'bul', hr: 'hrv', sr: 'srp', sl: 'slv', ca: 'cat', eu: 'eus', gl: 'glg', id: 'ind',
  ms: 'msa', th: 'tha', vi: 'vie', fa: 'fas', ur: 'urd', bn: 'ben', ta: 'tam', te: 'tel', ml: 'mal', mr: 'mar', gu: 'guj', kn: 'kan',
  pa: 'pan', sw: 'swa', af: 'afr', et: 'est', lv: 'lav', lt: 'lit', is: 'isl', ga: 'gle', cy: 'cym', fil: 'fil', tl: 'tgl',
};
export const lang3 = (tag) => {
  const base = (tag || '').toLowerCase().split(/[-_]/)[0];
  return base.length === 3 ? base : LANG3[base] || 'und';
};
const packLang = (code) => ((code.charCodeAt(0) - 0x60) << 10) | ((code.charCodeAt(1) - 0x60) << 5) | (code.charCodeAt(2) - 0x60);

// Subtitle cues [{ start, end, text }] (seconds) as tx3g samples, gaps filled with empty ones.
export function textSamples(cues) {
  const sorted = cues.filter((c) => c.end > c.start && c.text).sort((a, b) => a.start - b.start);
  const samples = [];
  let t = 0;
  const push = (from, to, text) => {
    const ms = Math.round(to * 1000) - Math.round(from * 1000);
    if (ms <= 0) return;
    const body = str(text);
    const data = new Uint8Array(2 + body.length);
    data.set(u16(body.length));
    data.set(body, 2);
    samples.push({ data, size: data.length, duration: ms, cto: 0, sync: true });
  };
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const start = Math.max(c.start, t);
    const end = Math.min(c.end, sorted[i + 1]?.start ?? c.end); // overlapping cues are cut
    if (start > t) push(t, start, '');
    if (end > start) push(start, end, c.text);
    t = Math.max(t, end);
  }
  return samples;
}

// The text sample description ffmpeg writes for mov_text (centered at the bottom,
// white Arial 16), so players treat it as plain default-styled text.
const TX3G = () =>
  box('stsd', u32(0), u32(1), box('tx3g', new Uint8Array(6), u16(1), u32(0), u8(1, 0xff), u32(0xff), new Uint8Array(8),
    u16(0), u16(0), u16(1), u8(0, 16), u32(0xffffffff),
    box('ftab', u16(1), u16(1), u8(5), str('Arial'))));

// stts/ctts-style run-length entries.
function runs(values) {
  const out = [];
  for (const v of values) {
    const last = out[out.length - 1];
    if (last && last[1] === v) last[0]++;
    else out.push([1, v]);
  }
  return out;
}

// The chunks of a track: runs of samples that sit next to each other in their
// source (or, for subtitles, that are built in memory), up to about a second each.
function chunksOf(track) {
  const chunks = [];
  let cur = null;
  let time = 0;
  for (const s of track.samples) {
    const fits = cur && cur.duration < track.timescale && cur.size < 4 << 20 && (s.data ? !!cur.data : !cur.data && cur.offset + cur.size === s.offset);
    if (fits) {
      cur.count++;
      cur.size += s.size;
      cur.duration += s.duration;
      if (s.data) cur.data.push(s.data);
    } else {
      cur = { track, count: 1, offset: s.offset, size: s.size, duration: s.duration, time: track.start + time / track.timescale, data: s.data ? [s.data] : null };
      chunks.push(cur);
    }
    time += s.duration;
  }
  return chunks;
}

// Writes a standard MP4. `tracks` come from readTracks (each with `blob`, its
// source file) or are subtitle tracks { kind: 'sbtl', cues, language, title, default }.
// `meta`: { title, artist, album, date, comment, cover: { bytes, type: 'jpeg'|'png' } };
// `chapters`: [{ start, title }] (seconds). `audioOnly` gives an .m4a.
// `forceLarge` writes 64-bit chunk offsets even for a small file (for tests).
export function writeMp4({ tracks, meta = {}, chapters = [], audioOnly = false, forceLarge = false }) {
  const MOVIE_SCALE = 1000;
  let nextId = 1;
  const prepared = tracks.map((t) => {
    if (t.kind === 'sbtl') {
      return { ...t, id: nextId++, timescale: 1000, start: 0, samples: textSamples(t.cues), stsd: TX3G(), language: lang3(t.language) };
    }
    return { ...t, id: nextId++ };
  });

  // Chunks of all tracks, interleaved by time.
  const chunks = prepared.flatMap((t) => chunksOf(t)).sort((a, b) => a.time - b.time);
  const mdatSize = chunks.reduce((n, c) => n + c.size, 0);
  const big = forceLarge || mdatSize > 0xffffffff - (1 << 24);

  const trakFor = (t, offsets) => {
    const tc = chunks.filter((c) => c.track === t);
    const mediaDuration = t.samples.reduce((n, s) => n + s.duration, 0);
    const edits = editsFor(t, mediaDuration);
    const shown = edits ? edits.reduce((n, e) => n + e.duration, 0) : mediaDuration / t.timescale;
    t.shown = shown;
    const v1 = (n) => n > 0xffffffff;
    const tkDuration = Math.round(shown * MOVIE_SCALE);
    const isSub = t.kind === 'sbtl';
    const flags = isSub && !t.default ? 0x2 : 0x3;
    const group = t.kind === 'soun' ? 1 : isSub ? 2 : 0;
    const tkhd = full('tkhd', v1(tkDuration) ? 1 : 0, flags,
      ...(v1(tkDuration) ? [u64(0), u64(0), u32(t.id), u32(0), u64(tkDuration)] : [u32(0), u32(0), u32(t.id), u32(0), u32(tkDuration)]),
      new Uint8Array(8), u16(0), u16(group), u16(t.kind === 'soun' ? 0x100 : 0), u16(0), ...MATRIX,
      u32(Math.round((t.width || 0) * 65536)), u32(Math.round((t.height || 0) * 65536)));
    const elst = edits && box('edts', full('elst', 1, 0, u32(edits.length), ...edits.flatMap((e) => {
      const mt = new Uint8Array(8);
      view(mt).setBigInt64(0, BigInt(e.mediaTime));
      return [u64(Math.round(e.duration * MOVIE_SCALE)), mt, u16(e.rate ?? 1), u16(0)];
    })));
    const handler = { vide: ['vide', 'VideoHandler'], soun: ['soun', 'SoundHandler'], sbtl: ['sbtl', t.title || 'SubtitleHandler'] }[t.kind] || [t.kind, 'Handler'];
    const mdhd = full('mdhd', v1(mediaDuration) ? 1 : 0, 0,
      ...(v1(mediaDuration) ? [u64(0), u64(0), u32(t.timescale), u64(mediaDuration)] : [u32(0), u32(0), u32(t.timescale), u32(mediaDuration)]),
      u16(packLang(/^[a-z]{3}$/.test(t.language || '') ? t.language : 'und')), u16(0));
    const hdlr = full('hdlr', 0, 0, u32(0), str(handler[0]), new Uint8Array(12), str(handler[1]), u8(0));
    const mediaHeader = t.kind === 'vide' ? full('vmhd', 0, 1, new Uint8Array(8)) : t.kind === 'soun' ? full('smhd', 0, 0, u32(0)) : full('nmhd', 0, 0);
    const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));

    const stts = runs(t.samples.map((s) => s.duration));
    const hasCto = t.samples.some((s) => s.cto);
    const negative = t.samples.some((s) => s.cto < 0);
    const stsc = runs(tc.map((c) => c.count)).reduce((out, [n, per], i, all) => {
      const first = all.slice(0, i).reduce((k, r) => k + r[0], 0) + 1;
      out.push([first, per]);
      return out;
    }, []);
    const sizes = t.samples.map((s) => s.size);
    const sameSize = sizes.every((x) => x === sizes[0]);
    const stbl = box('stbl',
      t.stsd,
      full('stts', 0, 0, u32(stts.length), u32s(stts.flat())),
      ...(hasCto ? [full('ctts', negative ? 1 : 0, 0, ...(() => {
        const r = runs(t.samples.map((s) => s.cto));
        return [u32(r.length), u32s(r.flat())];
      })())] : []),
      ...(t.samples.every((s) => s.sync) ? [] : [full('stss', 0, 0, ...(() => {
        const n = t.samples.map((s, i) => (s.sync ? i + 1 : 0)).filter(Boolean);
        return [u32(n.length), u32s(n)];
      })())]),
      full('stsc', 0, 0, u32(stsc.length), u32s(stsc.flatMap(([first, per]) => [first, per, 1]))),
      full('stsz', 0, 0, u32(sameSize ? sizes[0] || 0 : 0), u32(sizes.length), ...(sameSize ? [] : [u32s(sizes)])),
      big ? full('co64', 0, 0, u32(tc.length), u64s(tc.map((c) => offsets.get(c)))) : full('stco', 0, 0, u32(tc.length), u32s(tc.map((c) => offsets.get(c)))));
    return box('trak', tkhd, ...(elst ? [elst] : []), box('mdia', mdhd, hdlr, box('minf', mediaHeader, dinf, stbl)));
  };

  const udta = () => {
    const parts = [];
    if (chapters.length) {
      const list = chapters.slice(0, 255);
      parts.push(box('chpl', u32(0x01000000), u32(0), u8(list.length), ...list.flatMap((c) => {
        const title = str(c.title || '').slice(0, 255);
        return [u64(c.start * 1e7), u8(title.length), title];
      })));
    }
    const item = (key, value, type = 1) => box(key, box('data', u32(type), u32(0), value));
    const items = [];
    if (meta.title) items.push(item('\xa9nam', str(meta.title)));
    if (meta.artist) items.push(item('\xa9ART', str(meta.artist)));
    if (meta.album) items.push(item('\xa9alb', str(meta.album)));
    if (meta.date) items.push(item('\xa9day', str(meta.date)));
    if (meta.genre) items.push(item('\xa9gen', str(meta.genre)));
    if (meta.comment) items.push(item('\xa9cmt', str(meta.comment)));
    // desc is the short description players show; ldes holds all of it.
    if (meta.description) items.push(item('desc', str(meta.description.slice(0, 255))), item('ldes', str(meta.description)));
    if (meta.url) items.push(item('\xa9url', str(meta.url)));
    items.push(item('\xa9too', str('yt-dlp-extension')));
    if (meta.cover) items.push(item('covr', meta.cover.bytes, meta.cover.type === 'png' ? 14 : 13));
    parts.push(full('meta', 0, 0, full('hdlr', 0, 0, u32(0), str('mdir'), str('appl'), new Uint8Array(8), u8(0)), box('ilst', ...items)));
    return box('udta', ...parts);
  };

  const build = (offsets) => {
    const traks = prepared.map((t) => trakFor(t, offsets));
    const duration = Math.round(Math.max(0, ...prepared.map((t) => t.shown)) * MOVIE_SCALE);
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_SCALE), u32(duration), u32(0x10000), u16(0x100), new Uint8Array(10), ...MATRIX, new Uint8Array(24), u32(nextId));
    return box('moov', mvhd, ...traks, udta());
  };

  const ftyp = audioOnly
    ? box('ftyp', str('M4A '), u32(512), str('M4A '), str('isom'), str('iso2'), str('mp41'))
    : box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41'));

  // The moov's size doesn't depend on the offsets' values: build it once to
  // learn its size, then again with the real offsets.
  const placeholder = new Map(chunks.map((c) => [c, 0]));
  const moovSize = build(placeholder).length;
  const mdatHeader = big ? 16 : 8;
  let at = ftyp.length + moovSize + mdatHeader;
  const offsets = new Map();
  for (const c of chunks) offsets.set(c, at), (at += c.size);
  const moov = build(offsets);
  const header = big ? (() => {
    const h = new Uint8Array(16);
    view(h).setUint32(0, 1);
    h.set(str('mdat'), 4);
    view(h).setBigUint64(8, BigInt(16 + mdatSize));
    return h;
  })() : (() => {
    const h = new Uint8Array(8);
    view(h).setUint32(0, 8 + mdatSize);
    h.set(str('mdat'), 4);
    return h;
  })();
  const parts = [ftyp, moov, header];
  for (const c of chunks) parts.push(c.data ? new Blob(c.data) : c.track.blob.slice(c.offset, c.offset + c.size));
  return new Blob(parts, { type: audioOnly ? 'audio/mp4' : 'video/mp4' });
}

// The edit list a track needs: its source's (rescaled), with an empty edit in
// front when it starts after the others. Null when none is needed.
function editsFor(t, mediaDuration) {
  const src = t.edits?.length ? t.edits : null;
  if (!src && !(t.start > 0.0005)) return null;
  const out = [];
  if (t.start > 0.0005) out.push({ duration: t.start, mediaTime: -1, rate: 1 });
  if (src) {
    for (const e of src) {
      // An empty source edit before the media is already covered by `start`.
      if (e.mediaTime === -1 && out.length) continue;
      // Duration 0 (common in fragmented files) means "to the end of the media".
      const rest = (mediaDuration - Math.max(0, e.mediaTime)) / t.timescale;
      out.push({ duration: e.duration || rest, mediaTime: e.mediaTime, rate: e.rate ?? 1 });
    }
  } else {
    out.push({ duration: mediaDuration / t.timescale, mediaTime: 0, rate: 1 });
  }
  return out;
}
