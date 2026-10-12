// Minimal handling of fragmented MP4 (ISO BMFF): enough to read the tracks of an
// init segment and to change fragment times and track numbers in place. Pure
// logic, no UI, so it can be tested outside the browser.

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const type = (bytes, at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

// The boxes between `start` and `end`: { type, start, end, body } (body = where the content starts).
export function boxes(bytes, start = 0, end = bytes.length) {
  const v = view(bytes);
  const out = [];
  for (let at = start; at + 8 <= end; ) {
    let size = v.getUint32(at);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(v.getBigUint64(at + 8));
      body = at + 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < body - at || at + size > end) break; // truncated or not a box
    out.push({ type: type(bytes, at + 4), start: at, end: at + size, body });
    at += size;
  }
  return out;
}

const childrenOf = (bytes, box) => boxes(bytes, box.body, box.end);
const child = (bytes, box, t) => childrenOf(bytes, box).find((b) => b.type === t);

// Follows a path such as ['moov', 'trak', 'mdia'] and returns every box found at its end.
export function findAll(bytes, path, within = { body: 0, end: bytes.length }) {
  let level = [within];
  for (const t of path) level = level.flatMap((b) => childrenOf(bytes, b).filter((c) => c.type === t));
  return level;
}

// Tracks of an init segment: [{ id, timescale, kind: 'vide' | 'soun' | … }].
export function initTracks(bytes) {
  const v = view(bytes);
  return findAll(bytes, ['moov', 'trak']).map((trak) => {
    const tkhd = child(bytes, trak, 'tkhd');
    const mdia = child(bytes, trak, 'mdia');
    const mdhd = mdia && child(bytes, mdia, 'mdhd');
    const hdlr = mdia && child(bytes, mdia, 'hdlr');
    return {
      id: tkhd ? v.getUint32(tkhd.body + (bytes[tkhd.body] === 1 ? 20 : 12)) : 0,
      timescale: mdhd ? v.getUint32(mdhd.body + (bytes[mdhd.body] === 1 ? 20 : 12)) : 0,
      kind: hdlr ? type(bytes, hdlr.body + 8) : '',
    };
  });
}

// The fragments (moof boxes) in some bytes, with each track's decode time:
// [{ moof, tracks: [{ id, time, tfdt, tfhd }] }].
export function fragments(bytes) {
  const v = view(bytes);
  return boxes(bytes)
    .filter((b) => b.type === 'moof')
    .map((moof) => ({
      moof,
      tracks: childrenOf(bytes, moof)
        .filter((b) => b.type === 'traf')
        .map((traf) => {
          const tfhd = child(bytes, traf, 'tfhd');
          const tfdt = child(bytes, traf, 'tfdt');
          let time = null;
          if (tfdt) time = bytes[tfdt.body] === 1 ? Number(v.getBigUint64(tfdt.body + 4)) : v.getUint32(tfdt.body + 4);
          return { id: tfhd ? v.getUint32(tfhd.body + 4) : 0, time, tfdt, tfhd };
        }),
    }));
}

// Sets a fragment's decode time in place (clamped to what the box can hold).
export function setTime(bytes, tfdt, time) {
  const v = view(bytes);
  const t = Math.max(0, Math.round(time));
  if (bytes[tfdt.body] === 1) v.setBigUint64(tfdt.body + 4, BigInt(t));
  else v.setUint32(tfdt.body + 4, Math.min(t, 0xffffffff));
}

// Whether a fragment's data offsets are relative to the moof (so the fragment
// can be moved within the file): tfhd without an absolute base-data-offset.
export const movable = (bytes, tfhd) => !(bytes[tfhd.body + 3] & 0x01);

// Changes track numbers in place: `map` is old id -> new id. Works on init
// segments (tkhd, trex) and fragments (tfhd).
export function renumber(bytes, map) {
  const v = view(bytes);
  const swap = (at) => map.has(v.getUint32(at)) && v.setUint32(at, map.get(v.getUint32(at)));
  for (const tkhd of findAll(bytes, ['moov', 'trak', 'tkhd'])) swap(tkhd.body + (bytes[tkhd.body] === 1 ? 20 : 12));
  for (const trex of findAll(bytes, ['moov', 'mvex', 'trex'])) swap(trex.body + 4);
  for (const tfhd of findAll(bytes, ['moof', 'traf', 'tfhd'])) swap(tfhd.body + 4);
}

// Sets a fragment's sequence number in place.
export function setSequence(bytes, moof, n) {
  const mfhd = child(bytes, moof, 'mfhd');
  if (mfhd) view(bytes).setUint32(mfhd.body + 4, n);
}

// Builds a box from its type and content parts.
export function box(t, ...parts) {
  const size = 8 + parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  view(out).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = t.charCodeAt(i);
  let at = 8;
  for (const p of parts) out.set(p, at), (at += p.byteLength);
  return out;
}

// Retimes the fragments of one track file so it starts at 0 and plays straight
// through discontinuities (where the source's timestamps jump, e.g. inserted ads).
// addInit(bytes) registers an init segment's tracks; fix(bytes, { at, restart })
// retimes a segment in place: with `restart` (the first segment, or the first
// after a discontinuity) its earliest time is moved to `at` seconds, and later
// segments keep the same shift. Segment indexes (sidx) are dropped: their times
// and offsets no longer apply once segments are joined.
export function timeline() {
  const scales = new Map(); // track id -> timescale
  let shift = 0; // seconds taken off the original times
  let start = null; // the shift of the first segment: the original time of the output's 0
  return {
    addInit(bytes) {
      for (const t of initTracks(bytes)) if (t.timescale) scales.set(t.id, t.timescale);
    },
    fix(bytes, { at = 0, restart = false } = {}) {
      if (boxes(bytes).some((b) => b.type === 'sidx')) bytes = without(bytes, 'sidx');
      const timed = fragments(bytes).flatMap((f) => f.tracks).filter((t) => t.tfdt && scales.has(t.id));
      if ((restart || start === null) && timed.length) {
        shift = Math.min(...timed.map((t) => t.time / scales.get(t.id))) - at;
        start ??= shift;
      }
      for (const t of timed) setTime(bytes, t.tfdt, t.time - shift * scales.get(t.id));
      return bytes;
    },
    get start() {
      return start ?? 0;
    },
  };
}

// A copy of `bytes` without its top-level boxes of type `t`.
function without(bytes, t) {
  const keep = boxes(bytes).filter((b) => b.type !== t);
  const out = new Uint8Array(keep.reduce((n, b) => n + b.end - b.start, 0));
  let at = 0;
  for (const b of keep) out.set(bytes.subarray(b.start, b.end), at), (at += b.end - b.start);
  return out;
}

// Joins fragmented MP4 tracks saved in separate files (video first, then audio)
// into one file. Each track is { blob, index, start }: the file, the top-level
// boxes written to it ({ type, offset, size }) and the original time its 0
// stands for, in seconds, so the tracks keep their real offset. The result is a
// Blob made of slices of the inputs plus rewritten headers: the media data isn't
// copied, so the inputs must stay available until the result has been saved.
// Throws when the files can't be joined.
export async function mergeTracks(tracks) {
  const read = async (blob, b) => new Uint8Array(await blob.slice(b.offset, b.offset + b.size).arrayBuffer());
  const first = Math.min(...tracks.map((t) => t.start));

  // One init segment with every track, numbered without clashes.
  let ftyp = null;
  let moov = null;
  const traks = [];
  const trexes = [];
  const fragmentsByTrack = [];
  let nextId = 1;
  for (const t of tracks) {
    const initBoxes = t.index.filter((b) => b.type === 'ftyp' || b.type === 'moov');
    const moovBox = initBoxes.find((b) => b.type === 'moov');
    if (!moovBox) throw new Error('A track has no init segment.');
    const init = await read(t.blob, moovBox);
    const ids = new Map();
    const scales = new Map();
    for (const tr of initTracks(init)) {
      ids.set(tr.id, nextId++);
      scales.set(ids.get(tr.id), tr.timescale);
    }
    renumber(init, ids);
    const root = boxes(init)[0];
    if (!moov) {
      moov = { bytes: init, root };
      const f = initBoxes.find((b) => b.type === 'ftyp');
      if (f) ftyp = await read(t.blob, f);
    }
    traks.push(...findAll(init, ['trak'], root).map((b) => init.subarray(b.start, b.end)));
    trexes.push(...findAll(init, ['mvex', 'trex'], root).map((b) => init.subarray(b.start, b.end)));

    // Each fragment is a moof and the boxes after it up to the next moof (its mdat).
    const units = [];
    for (let i = 0; i < t.index.length; i++) {
      const b = t.index[i];
      if (b.type !== 'moof') continue;
      const data = [];
      for (let j = i + 1; j < t.index.length && t.index[j].type !== 'moof'; j++) if (t.index[j].type === 'mdat') data.push(t.index[j]);
      units.push({ moof: b, data, ids, scales, shift: t.start - first, blob: t.blob });
    }
    fragmentsByTrack.push(units);
  }

  // The new moov: the first file's, with its traks and trexes replaced by all of them.
  const { bytes: init, root } = moov;
  const kept = boxes(init, root.body, root.end).filter((b) => b.type !== 'trak' && b.type !== 'mvex');
  const mvex = findAll(init, ['mvex'], root)[0];
  const mvexRest = mvex ? boxes(init, mvex.body, mvex.end).filter((b) => b.type !== 'trex').map((b) => init.subarray(b.start, b.end)) : [];
  const mvhd = kept.find((b) => b.type === 'mvhd');
  if (mvhd) view(init).setUint32(mvhd.end - 4, nextId); // next_track_ID
  const newMoov = box('moov', ...kept.map((b) => init.subarray(b.start, b.end)), ...traks, box('mvex', ...mvexRest, ...trexes));

  // Fragments in time order, each moof renumbered and moved to the shared timeline.
  const all = [];
  for (const units of fragmentsByTrack) {
    for (const u of units) {
      const bytes = await read(u.blob, u.moof);
      renumber(bytes, u.ids);
      const [frag] = fragments(bytes);
      let time = Infinity;
      for (const tr of frag?.tracks || []) {
        if (!movable(bytes, tr.tfhd)) throw new Error('A fragment uses absolute data offsets.');
        const scale = u.scales.get(tr.id);
        if (!tr.tfdt || !scale) continue;
        setTime(bytes, tr.tfdt, tr.time + u.shift * scale);
        time = Math.min(time, tr.time / scale + u.shift);
      }
      all.push({ bytes, moof: frag.moof, time, data: u.data, blob: u.blob });
    }
  }
  all.sort((a, b) => a.time - b.time);
  const parts = [ftyp, newMoov].filter(Boolean);
  all.forEach((f, i) => {
    setSequence(f.bytes, f.moof, i + 1);
    parts.push(f.bytes, ...f.data.map((d) => f.blob.slice(d.offset, d.offset + d.size)));
  });
  return new Blob(parts, { type: 'video/mp4' });
}

// What a file holds, from its first bytes: ['video'], ['audio'], ['video', 'audio']…
// Null when the bytes don't include a whole moov.
export function trackKinds(bytes) {
  const moov = boxes(bytes).find((b) => b.type === 'moov');
  if (!moov) return null;
  const names = { vide: 'video', soun: 'audio' };
  return initTracks(bytes.subarray(moov.start, moov.end)).map((t) => names[t.kind]).filter(Boolean);
}

// The top-level boxes of a file (a Blob), read from their headers: [{ type, offset, size }].
export async function indexBlob(blob) {
  const out = [];
  for (let at = 0; at + 8 <= blob.size; ) {
    const h = new Uint8Array(await blob.slice(at, at + 16).arrayBuffer());
    const v = view(h);
    let size = v.getUint32(0);
    if (size === 1 && h.length >= 16) size = Number(v.getBigUint64(8));
    else if (size === 0) size = blob.size - at;
    if (size < 8 || at + size > blob.size) break;
    out.push({ type: type(h, 4), offset: at, size });
    at += size;
  }
  return out;
}
