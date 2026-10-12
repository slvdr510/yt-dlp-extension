// HLS playlist parsing and segment downloading. Pure logic, no UI, so it can be
// tested outside the browser.
import { timeline, boxes } from './fmp4.js';

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
  const res = { variants: [], media: [], segments: [], endList: false };
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

// Downloads every segment in order and writes it to `sink`. Several segments
// are fetched at once, but at most `ahead` are held in memory.
// With `convert`, MPEG-TS is remuxed to MP4 using mux.js. If mux.js produces
// nothing for the first segment (unsupported codec), it falls back to raw output.
// MP4 output is retimed to start at 0 and to play straight through discontinuities.
// Resolves to { converted, mp4, start, dropped, formatChanged, index }: whether
// mux.js converted it, whether the output is MP4, the original time its 0 stands
// for (in seconds), how many segments mux.js couldn't convert, whether the format
// changed mid-way, and the top-level boxes written (for joining tracks later).
export async function downloadTrack({ segments, convert, sink, signal: outer, onProgress, muxjs, concurrency = 6, ahead = 24 }) {
  // Aborted when the track fails too, so the segments still in flight stop.
  const failed = new AbortController();
  const signal = outer ? AbortSignal.any([outer, failed.signal]) : failed.signal;
  try {
    return await download();
  } catch (e) {
    failed.abort(e);
    throw e;
  }

  async function download() {
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

    const limit = limiter(concurrency);
    const tasks = [];
    let launched = 0;
    const launch = (i) => {
      const s = segments[i];
      const p = limit(() => withRetry(() => fetchBytes(s.uri, s.range, signal), signal)).then((d) => decrypt(d, s.key, s.seq));
      p.catch(() => {}); // awaited later, in order
      tasks[i] = p;
    };

    // Original timestamps are kept so separate tracks stay in sync; the timeline
    // below moves them to start at 0.
    let transmuxer = null;
    let out = [];
    let initWritten = false;
    if (convert) {
      transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
      transmuxer.on('data', (seg) => {
        if (!initWritten) out.push(seg.initSegment);
        out.push(seg.data);
      });
    }

    const time = timeline();
    let initKey = null;
    let firstInit = null;
    let formatChanged = false;
    let dropped = 0;
    let bytes = 0;
    let at = 0; // where the current segment starts, in seconds, from the playlist
    const index = []; // top-level boxes of MP4 output: { type, offset, size }
    const write = async (chunk, mp4) => {
      if (mp4) for (const b of boxes(chunk)) index.push({ type: b.type, offset: bytes + b.start, size: b.end - b.start });
      await sink.write(chunk);
      bytes += chunk.byteLength;
    };

    for (let i = 0; i < segments.length; i++) {
      while (launched < Math.min(segments.length, i + ahead)) launch(launched++);
      const data = await tasks[i];
      tasks[i] = null;
      const s = segments[i];
      const restart = i === 0 || s.disc; // a new timeline: the first segment or a discontinuity

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
      if (transmuxer) {
        if (s.disc) transmuxer.reset(); // the timestamps jump: don't let mux.js bridge the gap
        transmuxer.push(data);
        transmuxer.flush();
        if (out.length) {
          if (!initWritten) {
            time.addInit(out[0]);
            initWritten = true;
          }
          chunks = out;
          out = [];
        } else if (i === 0) {
          transmuxer = null; // fall back to the original stream
        } else {
          chunks = [];
          dropped++;
        }
      }
      const mp4 = !!(transmuxer || s.map);
      if (mp4) chunks = chunks.map((c) => time.fix(c, { at, restart }));
      for (const c of chunks) await write(c, mp4);
      at += s.duration;
      onProgress?.({ done: i + 1, total: segments.length, bytes });
    }
    return { converted: !!transmuxer, mp4: initWritten, start: time.start, dropped, formatChanged, index };
  }
}
