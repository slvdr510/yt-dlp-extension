// HLS playlist parsing and segment downloading. Pure logic, no UI, so it can be
// tested outside the browser.
import { timeline, boxes } from './fmp4.js';
import { createRemuxer } from './ts.js';

export function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

function parseRange(s, prevEnd) {
  const [len, off] = s.split('@');
  const start = off !== undefined ? Number(off) : prevEnd;
  return { start, end: start + Number(len) - 1 };
}

// Returns { variants, media, segments, endList }. A master playlist fills
// `variants` (and `media` for alternate audio); a media playlist fills `segments`.
export function parsePlaylist(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('The response is not an HLS playlist');
  const abs = (u) => new URL(u, base).href;
  const res = { variants: [], media: [], segments: [], endList: false, targetDuration: 0 };
  let sequence = 0;
  let variant = null;
  let key = null;
  let map = null;
  let range = null;
  let rangeEnd = 0;
  let duration = 0;
  let disc = false; // the next segment follows a discontinuity

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) variant = parseAttrs(line.slice(18));
    else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      if (a.URI) a.URI = abs(a.URI);
      res.media.push(a);
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = parseInt(line.slice(22), 10) || 0;
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      key = a.METHOD === 'NONE' ? null : { method: a.METHOD, uri: a.URI ? abs(a.URI) : null, iv: a.IV || null, format: a.KEYFORMAT || 'identity' };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      map = { uri: abs(a.URI), range: a.BYTERANGE ? parseRange(a.BYTERANGE, 0) : null, key };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) range = parseRange(line.slice(17), rangeEnd);
    else if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8)) || 0;
    else if (line === '#EXT-X-ENDLIST') res.endList = true;
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) res.targetDuration = Number(line.slice(22)) || 0;
    else if (line === '#EXT-X-DISCONTINUITY') disc = true;
    else if (!line.startsWith('#')) {
      if (variant) {
        res.variants.push({ ...variant, uri: abs(line) });
        variant = null;
        continue;
      }
      res.segments.push({ uri: abs(line), duration, key, map, range, seq: sequence + res.segments.length, disc });
      disc = false;
      if (range) rangeEnd = range.end + 1;
      range = null;
      duration = 0;
    }
  }
  return res;
}

// The subtitle renditions of a master playlist's EXT-X-MEDIA entries (WebVTT
// playlists): [{ type: 'hls', uri, lang, name, default }].
export function subtitleRenditions(media) {
  const seen = new Set();
  return media
    .filter((m) => m.TYPE === 'SUBTITLES' && m.URI && !seen.has(m.URI) && seen.add(m.URI))
    .map((m) => ({ type: 'hls', uri: m.URI, lang: m.LANGUAGE || '', name: `${m.NAME || m.LANGUAGE || 'Subtitles'}${m.FORCED === 'YES' ? ' (forced)' : ''}`, default: m.DEFAULT === 'YES' && m.FORCED !== 'YES' }));
}

// Returns the encryption method if the stream uses one we can't handle (DRM), else null.
export function unsupportedEncryption(segments) {
  for (const s of segments) {
    for (const k of [s.key, s.map?.key]) {
      if (k && (k.method !== 'AES-128' || k.format !== 'identity' || !k.uri)) return k.method;
    }
  }
  return null;
}

export async function fetchBytes(url, range, signal) {
  const headers = range ? { Range: `bytes=${range.start}-${range.end ?? ''}` } : undefined;
  const r = await fetch(url, { credentials: 'include', headers, signal });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} for ${url}`), { status: r.status });
  return new Uint8Array(await r.arrayBuffer());
}

export async function fetchText(url, signal) {
  const r = await fetch(url, { credentials: 'include', signal });
  if (!r.ok) throw new Error(`HTTP ${r.status} loading playlist`);
  return { text: await r.text(), url: r.url || url };
}

async function withRetry(fn, signal, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted || i >= tries || [401, 403, 404, 410].includes(e.status)) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
    }
  }
}

function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((resolve, reject) => (queue.push({ fn, resolve, reject }), next()));
}

function hexToBytes(hex) {
  const h = hex.replace(/^0x/i, '').padStart(32, '0');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

// Default IV when EXT-X-KEY has none: the media sequence number, big-endian.
export function ivFromSequence(seq) {
  const iv = new Uint8Array(16);
  const v = new DataView(iv.buffer);
  v.setUint32(8, Math.floor(seq / 2 ** 32));
  v.setUint32(12, seq >>> 0);
  return iv;
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Turns segments, in order, into one file: decrypts them, converts MPEG-TS (and
// packed audio) to MP4 with ts.js (with `convert`; if the first segment holds
// nothing it can convert, it keeps the original stream), retimes
// MP4 output to start at 0 and to play straight through discontinuities, and
// writes it to `sink`. fetch(segment) gets a segment's bytes (decrypted);
// add(segment, bytes) writes it; result() says what came out: { converted, mp4,
// start, dropped, formatChanged, index, bytes } (whether it was converted, whether
// it's MP4, the original time its 0 stands for in seconds, segments that couldn't
// be converted, whether the format changed mid-way, the top-level boxes written).
export function segmentWriter({ sink, convert, signal }) {
  const keys = new Map();
  const getKey = (uri) => {
    if (!keys.has(uri)) {
      keys.set(
        uri,
        withRetry(() => fetchBytes(uri, null, signal), signal).then((b) => {
          if (b.length !== 16) throw new Error('Invalid AES-128 key');
          return crypto.subtle.importKey('raw', b, 'AES-CBC', false, ['decrypt']);
        })
      );
    }
    return keys.get(uri);
  };
  const decrypt = async (data, key, seq) => {
    if (!key) return data;
    const iv = key.iv ? hexToBytes(key.iv) : ivFromSequence(seq);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, await getKey(key.uri), data));
  };

  // Original timestamps are kept so separate tracks stay in sync; the timeline
  // below moves them to start at 0.
  let remuxer = convert ? createRemuxer() : null;
  let initWritten = false;

  const time = timeline();
  let initKey = null;
  let firstInit = null;
  let formatChanged = false;
  let dropped = 0;
  let bytes = 0;
  let count = 0;
  let at = 0; // where the current segment starts, in seconds, from the playlist
  const index = []; // top-level boxes of MP4 output: { type, offset, size }
  const write = async (chunk, mp4) => {
    if (mp4) for (const b of boxes(chunk)) index.push({ type: b.type, offset: bytes + b.start, size: b.end - b.start });
    await sink.write(chunk);
    bytes += chunk.byteLength;
  };

  return {
    fetch: (s) => withRetry(() => fetchBytes(s.uri, s.range, signal), signal).then((d) => decrypt(d, s.key, s.seq)),

    async add(s, data) {
      const restart = count === 0 || s.disc; // a new timeline: the first segment or a discontinuity

      // fMP4: one init segment for the whole file. A different one later (an ad in
      // another format) can't be joined in; what follows may not play right.
      const key = s.map && `${s.map.uri}|${s.map.range?.start}`;
      if (s.map && key !== initKey) {
        initKey = key;
        let init = await withRetry(() => fetchBytes(s.map.uri, s.map.range, signal), signal);
        if (s.map.key?.iv) init = await decrypt(init, s.map.key, 0);
        if (!firstInit) {
          firstInit = init;
          time.addInit(init);
          await write(init, true);
          initWritten = true;
        } else if (!sameBytes(init, firstInit)) {
          formatChanged = true;
        }
      }

      let chunks = [data];
      if (remuxer) {
        if (s.disc) remuxer.reset(); // the timestamps jump: don't bridge the gap
        const out = remuxer.push(data);
        if (out) {
          chunks = [out.data];
          if (out.init) {
            time.addInit(out.init);
            chunks.unshift(out.init);
            initWritten = true;
          }
          if (out.changed) formatChanged = true;
        } else if (count === 0) {
          remuxer = null; // nothing it can convert: keep the original stream
        } else {
          chunks = [];
          dropped++;
        }
      }
      const mp4 = !!(remuxer || s.map);
      if (mp4) chunks = chunks.map((c) => time.fix(c, { at, restart }));
      for (const c of chunks) await write(c, mp4);
      at += s.duration;
      count++;
    },

    result: () => ({ converted: !!remuxer, mp4: initWritten, start: time.start, dropped, formatChanged, index, bytes, duration: at }),
  };
}

// Downloads every segment in order and writes it to `sink` (see segmentWriter).
// Several segments are fetched at once, but at most `ahead` are held in memory.
export async function downloadTrack({ segments, convert, sink, signal: outer, onProgress, concurrency = 6, ahead = 24 }) {
  // Aborted when the track fails too, so the segments still in flight stop.
  const failed = new AbortController();
  const signal = outer ? AbortSignal.any([outer, failed.signal]) : failed.signal;
  const writer = segmentWriter({ sink, convert, signal });
  const limit = limiter(concurrency);
  const tasks = [];
  let launched = 0;
  const launch = (i) => {
    const p = limit(() => writer.fetch(segments[i]));
    p.catch(() => {}); // awaited later, in order
    tasks[i] = p;
  };
  try {
    for (let i = 0; i < segments.length; i++) {
      while (launched < Math.min(segments.length, i + ahead)) launch(launched++);
      const data = await tasks[i];
      tasks[i] = null;
      await writer.add(segments[i], data);
      onProgress?.({ done: i + 1, total: segments.length, bytes: writer.result().bytes });
    }
    return writer.result();
  } catch (e) {
    failed.abort(e);
    throw e;
  }
}

// Waits `seconds`, waking early when any of `signals` fires.
function nap(seconds, ...signals) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, seconds * 1000);
    for (const s of signals.filter(Boolean)) s.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

// Records a live HLS media playlist: keeps reading it and writes each new segment
// (see segmentWriter) until `stop` fires, the playlist ends (#EXT-X-ENDLIST), or
// it stops growing for a while. It starts at the live edge (the last `edge`
// segments) unless `fromStart`. `signal` cancels it (the recording is lost).
// Resolves like segmentWriter's result, plus { missed, ended }: segments that left
// the playlist before they could be fetched, and why it ended ('stop', 'end', 'stalled').
export async function recordLive({ url, sink, convert, signal, stop, onProgress, fromStart = false, edge = 3 }) {
  const writer = segmentWriter({ sink, convert, signal });
  let next = null; // the media sequence number of the next segment to record
  let missed = 0;
  let gap = false;
  let lastNew = Date.now();
  let ended = null;
  while (!ended) {
    const { text, url: finalUrl } = await fetchText(url, signal);
    const p = parsePlaylist(text, finalUrl);
    const target = p.targetDuration || 6;
    const segs = p.segments;
    if (next === null) next = segs.length ? segs[fromStart ? 0 : Math.max(0, segs.length - edge)].seq : 0;
    // The window moved past segments we hadn't fetched yet (a slow connection).
    if (segs.length && segs[0].seq > next) {
      missed += segs[0].seq - next;
      next = segs[0].seq;
      gap = true;
    }
    for (const s of segs) {
      if (s.seq < next) continue;
      if (stop?.aborted) break;
      const data = await writer.fetch(s);
      // After a gap the timestamps jump: start a new timeline there.
      await writer.add(gap ? { ...s, disc: true } : s, data);
      gap = false;
      next = s.seq + 1;
      lastNew = Date.now();
      const r = writer.result();
      onProgress?.({ duration: r.duration, bytes: r.bytes, missed });
    }
    if (stop?.aborted) ended = 'stop';
    else if (p.endList) ended = 'end';
    else if (Date.now() - lastNew > Math.max(30, target * 6) * 1000) ended = 'stalled';
    else await nap(Math.max(1, target / 2), stop, signal);
    signal?.throwIfAborted();
  }
  return { ...writer.result(), missed, ended };
}
