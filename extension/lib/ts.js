// MPEG-TS (and HLS packed audio) to fragmented MP4, in place of mux.js.
// Video: H.264, HEVC. Audio: AAC (ADTS), AC-3, E-AC-3, MPEG audio (MP3/MP2).
// Timestamps are kept as they are in the stream (the 90 kHz clock, unwrapped past
// its 33-bit limit), so separate tracks stay in sync; the caller retimes them.
// Pure logic, no UI, so it can be tested outside the browser.
import { box } from './fmp4.js';

// ---------- bytes and bits ----------

const u8 = (...n) => Uint8Array.from(n);
const u16 = (n) => u8((n >> 8) & 255, n & 255);
const u32 = (n) => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const u64 = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(Math.max(0, Math.round(n))));
  return b;
};
const full = (type, version, flags, ...parts) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
};

class Bits {
  constructor(bytes) {
    this.b = bytes;
    this.pos = 0;
  }
  bit() {
    const v = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  skip(n) {
    this.pos += n;
  }
  ue() {
    let zeros = 0;
    while (!this.bit() && zeros < 32) zeros++;
    return 2 ** zeros - 1 + this.bits(zeros);
  }
  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

// NAL unit payload without the emulation-prevention bytes (00 00 03 -> 00 00).
function unescape(nal) {
  const out = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Uint8Array.from(out);
}

// The NAL units of an Annex B byte stream (start codes 00 00 01 / 00 00 00 01).
function nalUnits(data) {
  const starts = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  return starts.map((s, k) => {
    let end = k + 1 < starts.length ? starts[k + 1] - 3 : data.length;
    while (end > s && data[end - 1] === 0) end--; // trailing zeros (4-byte start codes)
    return data.subarray(s, end);
  });
}

// ---------- video ----------

const HIGH_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

function parseAvcSps(sps) {
  const r = new Bits(unescape(sps));
  r.skip(8); // NAL header
  const profile = r.bits(8);
  r.skip(8);
  r.skip(8); // level
  r.ue();
  let chroma = 1;
  let depthLuma = 8;
  let depthChroma = 8;
  if (HIGH_PROFILES.includes(profile)) {
    chroma = r.ue();
    if (chroma === 3) r.skip(1);
    depthLuma = r.ue() + 8;
    depthChroma = r.ue() + 8;
    r.skip(1);
    if (r.bit()) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (!r.bit()) continue;
        let last = 8;
        let next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64) && next !== 0; j++) {
          next = (last + r.se() + 256) % 256;
          last = next || last;
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.skip(1);
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue();
  r.skip(1);
  const wMbs = r.ue() + 1;
  const hMaps = r.ue() + 1;
  const frameOnly = r.bit();
  if (!frameOnly) r.skip(1);
  r.skip(1);
  let crop = [0, 0, 0, 0];
  if (r.bit()) crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  const unitX = chroma === 1 || chroma === 2 ? 2 : 1;
  const unitY = (chroma === 1 ? 2 : 1) * (2 - frameOnly);
  return {
    width: wMbs * 16 - (crop[0] + crop[1]) * unitX,
    height: (2 - frameOnly) * hMaps * 16 - (crop[2] + crop[3]) * unitY,
    profile,
    chroma,
    depthLuma,
    depthChroma,
  };
}

function avcSampleEntry(sps, pps) {
  const info = parseAvcSps(sps);
  const parts = [u8(1, sps[1], sps[2], sps[3], 0xff, 0xe0 | 1), u16(sps.length), sps, u8(1), u16(pps.length), pps];
  if (HIGH_PROFILES.includes(info.profile)) parts.push(u8(0xfc | info.chroma, 0xf8 | (info.depthLuma - 8), 0xf8 | (info.depthChroma - 8), 0));
  return { entry: visualEntry('avc1', info, box('avcC', ...parts)), ...info };
}

function parseHevcSps(sps) {
  const r = new Bits(unescape(sps));
  r.skip(16); // NAL header
  r.skip(4);
  const maxSub = r.bits(3);
  const nesting = r.bit();
  // profile_tier_level
  const ptl = { space: r.bits(2), tier: r.bit(), idc: r.bits(5) };
  ptl.compat = r.bits(32);
  ptl.constraint = [];
  for (let i = 0; i < 6; i++) ptl.constraint.push(r.bits(8));
  ptl.level = r.bits(8);
  const subProfile = [];
  const subLevel = [];
  for (let i = 0; i < maxSub; i++) {
    subProfile.push(r.bit());
    subLevel.push(r.bit());
  }
  if (maxSub > 0) for (let i = maxSub; i < 8; i++) r.skip(2);
  for (let i = 0; i < maxSub; i++) {
    if (subProfile[i]) r.skip(88);
    if (subLevel[i]) r.skip(8);
  }
  r.ue(); // sps_seq_parameter_set_id
  const chroma = r.ue();
  if (chroma === 3) r.skip(1);
  let width = r.ue();
  let height = r.ue();
  if (r.bit()) {
    const [l, rt, t, b] = [r.ue(), r.ue(), r.ue(), r.ue()];
    const subW = chroma === 1 || chroma === 2 ? 2 : 1;
    const subH = chroma === 1 ? 2 : 1;
    width -= (l + rt) * subW;
    height -= (t + b) * subH;
  }
  return { width, height, chroma, depthLuma: r.ue() + 8, depthChroma: r.ue() + 8, ptl, maxSub, nesting };
}

function hevcSampleEntry(vps, sps, pps) {
  const info = parseHevcSps(sps);
  const { ptl } = info;
  const array = (type, nal) => concat([u8(0x80 | type), u16(1), u16(nal.length), nal]);
  const hvcC = box('hvcC',
    u8(1, (ptl.space << 6) | (ptl.tier << 5) | ptl.idc), u32(ptl.compat), Uint8Array.from(ptl.constraint), u8(ptl.level),
    u16(0xf000), u8(0xfc), u8(0xfc | info.chroma), u8(0xf8 | (info.depthLuma - 8)), u8(0xf8 | (info.depthChroma - 8)),
    u16(0), u8(((info.maxSub + 1) << 3) | (info.nesting << 2) | 3),
    u8(3), array(32, vps), array(33, sps), array(34, pps));
  return { entry: visualEntry('hvc1', info, hvcC), ...info };
}

function visualEntry(type, { width, height }, config) {
  return box(type, new Uint8Array(6), u16(1), new Uint8Array(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Uint8Array(32), u16(0x18), u16(0xffff), config);
}

// ---------- audio ----------

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const AC3_RATES = [48000, 44100, 32000];
const AC3_WORDS = [
  [64, 64, 80, 80, 96, 96, 112, 112, 128, 128, 160, 160, 192, 192, 224, 224, 256, 256, 320, 320, 384, 384, 448, 448, 512, 512, 640, 640, 768, 768, 896, 896, 1024, 1024, 1152, 1152, 1280, 1280],
  [69, 70, 87, 88, 104, 105, 121, 122, 139, 140, 174, 175, 208, 209, 243, 244, 278, 279, 348, 349, 417, 418, 487, 488, 557, 558, 696, 697, 835, 836, 975, 976, 1114, 1115, 1253, 1254, 1393, 1394],
  [96, 96, 120, 120, 144, 144, 168, 168, 192, 192, 240, 240, 288, 288, 336, 336, 384, 384, 480, 480, 576, 576, 672, 672, 768, 768, 960, 960, 1152, 1152, 1344, 1344, 1536, 1536, 1728, 1728, 1920, 1920],
];
const AC3_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];
// MPEG audio: kbps by [version 1 | 2] [layer I, II, III], and sample rates by version.
const MPA_KBPS = {
  1: [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  2: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
};
const MPA_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// One audio frame at `at`: { size, samples, rate, channels, config } or null when
// there's no (complete) frame there. `config` describes the stream for its sample entry.
const FRAMES = {
  aac(d, at) {
    if (at + 7 > d.length || d[at] !== 0xff || (d[at + 1] & 0xf6) !== 0xf0) return null;
    const objectType = ((d[at + 2] >> 6) & 3) + 1;
    const rateIndex = (d[at + 2] >> 2) & 0xf;
    const channels = ((d[at + 2] & 1) << 2) | (d[at + 3] >> 6);
    const size = ((d[at + 3] & 3) << 11) | (d[at + 4] << 3) | (d[at + 5] >> 5);
    const header = d[at + 1] & 1 ? 7 : 9;
    if (!AAC_RATES[rateIndex] || size < header || at + size > d.length) return null;
    return { size, skip: header, samples: 1024, rate: AAC_RATES[rateIndex], channels, config: { codec: 'aac', objectType, rateIndex, channels } };
  },
  ac3(d, at) {
    if (at + 7 > d.length || d[at] !== 0x0b || d[at + 1] !== 0x77) return null;
    const fscod = d[at + 4] >> 6;
    const frmsizecod = d[at + 4] & 0x3f;
    if (fscod === 3 || frmsizecod > 37) return null;
    const size = AC3_WORDS[fscod][frmsizecod] * 2;
    if (at + size > d.length) return null;
    const r = new Bits(d.subarray(at + 5, at + 8));
    const bsid = r.bits(5);
    const bsmod = r.bits(3);
    const acmod = r.bits(3);
    if (acmod & 1 && acmod !== 1) r.skip(2);
    if (acmod & 4) r.skip(2);
    if (acmod === 2) r.skip(2);
    const lfeon = r.bit();
    return { size, skip: 0, samples: 1536, rate: AC3_RATES[fscod], channels: AC3_CHANNELS[acmod] + lfeon, config: { codec: 'ac-3', fscod, bsid, bsmod, acmod, lfeon, bitRateCode: frmsizecod >> 1 } };
  },
  eac3(d, at) {
    if (at + 6 > d.length || d[at] !== 0x0b || d[at + 1] !== 0x77) return null;
    // An access unit: the independent frame and the dependent ones after it.
    let size = 0;
    let first = null;
    while (at + size + 6 <= d.length && d[at + size] === 0x0b && d[at + size + 1] === 0x77) {
      const p = at + size;
      const strmtyp = d[p + 2] >> 6;
      if (first && strmtyp !== 1) break;
      const frame = (((d[p + 2] & 7) << 8) | d[p + 3]) * 2 + 2;
      if (p + frame > d.length) return null;
      if (!first) {
        const fscod = d[p + 4] >> 6;
        const blocks = fscod === 3 ? 6 : [1, 2, 3, 6][(d[p + 4] >> 4) & 3];
        const rate = fscod === 3 ? [24000, 22050, 16000][(d[p + 4] >> 4) & 3] : AC3_RATES[fscod];
        const acmod = (d[p + 4] >> 1) & 7;
        const lfeon = d[p + 4] & 1;
        first = { blocks, rate, fscod: fscod === 3 ? AC3_RATES.indexOf(rate) : fscod, acmod, lfeon, bsid: d[p + 5] >> 3, frame };
      }
      size += frame;
    }
    if (!first) return null;
    const samples = first.blocks * 256;
    const kbps = Math.round((first.frame * 8 * first.rate) / samples / 1000);
    return { size, skip: 0, samples, rate: first.rate, channels: AC3_CHANNELS[first.acmod] + first.lfeon, config: { codec: 'ec-3', fscod: first.fscod, bsid: first.bsid, acmod: first.acmod, lfeon: first.lfeon, kbps } };
  },
  mpa(d, at) {
    if (at + 4 > d.length || d[at] !== 0xff || (d[at + 1] & 0xe0) !== 0xe0) return null;
    const version = (d[at + 1] >> 3) & 3; // 3: MPEG-1, 2: MPEG-2, 0: MPEG-2.5
    const layer = 4 - ((d[at + 1] >> 1) & 3); // 1, 2, 3
    const bitrateIndex = d[at + 2] >> 4;
    const rateIndex = (d[at + 2] >> 2) & 3;
    if (version === 1 || layer === 4 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
    const kbps = MPA_KBPS[version === 3 ? 1 : 2][layer - 1][bitrateIndex];
    const rate = MPA_RATES[version][rateIndex];
    const pad = (d[at + 2] >> 1) & 1;
    const samples = layer === 1 ? 384 : layer === 3 && version !== 3 ? 576 : 1152;
    const size = layer === 1 ? (Math.floor((12 * kbps * 1000) / rate) + pad) * 4 : Math.floor(((samples / 8) * kbps * 1000) / rate) + pad;
    if (at + size > d.length) return null;
    const channels = d[at + 3] >> 6 === 3 ? 1 : 2;
    return { size, skip: 0, samples, rate, channels, config: { codec: 'mpa', mpeg1: version === 3, channels } };
  },
};

function audioSampleEntry(c, rate, channels) {
  // The sample rate is 16.16 fixed point: rates from 64 kHz up don't fit, and are written as 0.
  const head = (type, extra) => box(type, new Uint8Array(6), u16(1), new Uint8Array(8), u16(channels), u16(16), u32(0), u32(rate < 65536 ? rate * 65536 : 0), extra);
  const descriptor = (tag, ...parts) => {
    const body = concat(parts);
    return concat([u8(tag, 0x80, 0x80, 0x80, body.length), body]);
  };
  const esds = (oti, specific) =>
    full('esds', 0, 0, descriptor(3, u16(0), u8(0), descriptor(4, u8(oti, 0x15), u8(0, 0, 0), u32(0), u32(0), ...(specific ? [descriptor(5, specific)] : [])), descriptor(6, u8(2))));
  if (c.codec === 'aac') return head('mp4a', esds(0x40, u16((c.objectType << 11) | (c.rateIndex << 7) | (c.channels << 3))));
  if (c.codec === 'mpa') return head('mp4a', esds(c.mpeg1 ? 0x6b : 0x69));
  if (c.codec === 'ac-3') {
    const v = (c.fscod << 22) | (c.bsid << 17) | (c.bsmod << 14) | (c.acmod << 11) | (c.lfeon << 10) | (c.bitRateCode << 5);
    return head('ac-3', box('dac3', u8((v >> 16) & 255, (v >> 8) & 255, v & 255)));
  }
  // ec-3: one independent substream, no dependent ones described.
  const bits = [[c.kbps, 13], [0, 3], [c.fscod, 2], [c.bsid, 5], [0, 1], [0, 1], [0, 3], [c.acmod, 3], [c.lfeon, 1], [0, 3], [0, 4], [0, 1]];
  let v = 0n;
  for (const [x, n] of bits) v = (v << BigInt(n)) | BigInt(x);
  const dec3 = new Uint8Array(5);
  for (let i = 4; i >= 0; i--) (dec3[i] = Number(v & 255n)), (v >>= 8n);
  return head('ec-3', box('dec3', dec3));
}

// ---------- the remuxer ----------

const VIDEO_TYPES = { 0x1b: 'h264', 0x24: 'hevc' };
const AUDIO_TYPES = { 0x0f: 'aac', 0x81: 'ac3', 0x87: 'eac3', 0x03: 'mpa', 0x04: 'mpa' };
const WRAP = 2 ** 33;

// Reads a PES header: { pts, dts, payload } (timestamps on the 90 kHz clock, or null).
function readPes(p) {
  if (p.length < 9 || p[0] !== 0 || p[1] !== 0 || p[2] !== 1) return null;
  const flags = p[7] >> 6;
  const ts = (at) => (p[at] & 0x0e) * 536870912 + p[at + 1] * 4194304 + (p[at + 2] & 0xfe) * 16384 + p[at + 3] * 128 + (p[at + 4] >> 1);
  const pts = flags & 2 ? ts(9) : null;
  const dts = flags === 3 ? ts(14) : pts;
  return { pts, dts, payload: p.subarray(9 + p[8]) };
}

// The timestamp in an HLS packed-audio segment's ID3 tag (Apple's PRIV frame), or null.
function id3Timestamp(d) {
  if (d.length < 10 || d[0] !== 0x49 || d[1] !== 0x44 || d[2] !== 0x33) return { pts: null, end: 0 };
  const size = ((d[6] & 0x7f) << 21) | ((d[7] & 0x7f) << 14) | ((d[8] & 0x7f) << 7) | (d[9] & 0x7f);
  const end = 10 + size;
  const owner = 'com.apple.streaming.transportStreamTimestamp';
  for (let at = 10; at + 10 < end; ) {
    const id = String.fromCharCode(d[at], d[at + 1], d[at + 2], d[at + 3]);
    const len = (d[at + 4] << 24) | (d[at + 5] << 16) | (d[at + 6] << 8) | d[at + 7];
    if (!len) break;
    const body = d.subarray(at + 10, at + 10 + len);
    if (id === 'PRIV' && new TextDecoder().decode(body.subarray(0, owner.length)) === owner) {
      const t = body.subarray(owner.length + 1);
      return { pts: (t[3] & 1) * 4294967296 + ((t[4] << 24) >>> 0) + (t[5] << 16) + (t[6] << 8) + t[7], end };
    }
    at += 10 + len;
  }
  return { pts: null, end };
}

// The audio codec of a packed-audio segment (no TS), from its first frame.
function sniffAudio(d, at) {
  for (const kind of ['aac', 'ac3', 'eac3', 'mpa']) {
    if (kind === 'eac3' && !(d[at] === 0x0b && d[at + 1] === 0x77 && (d[at + 5] >> 3) > 10)) continue;
    if (kind === 'ac3' && (d[at + 5] >> 3) > 10) continue;
    if (FRAMES[kind](d, at)) return kind;
  }
  return null;
}

// Converts segment after segment (push), like mux.js's Transmuxer with original
// timestamps: each push gives { init, data } (init the first time only: the
// sample descriptions), or null when the segment holds nothing it can convert.
export function createRemuxer() {
  let pmt = null; // PID of the program map table
  let videoPid = null;
  let audioPid = null;
  let videoCodec = null;
  let audioKind = null;
  let initDone = false; // the init segment (sample descriptions) was given out
  let sequence = 0;
  let ref = null; // the last timestamp seen, to unwrap the 33-bit clock
  const tracks = { video: null, audio: null }; // { entry, timescale, width, height } once known
  let lastVideoDuration = 3000;
  let audioNext = null; // the 90 kHz time of the next audio frame
  let audioLeft = new Uint8Array(0); // a frame cut at the end of the previous PES
  const params = {}; // h264: sps, pps; hevc: vps, sps, pps
  let paramsChanged = false;

  const unwrap = (t) => {
    if (t === null) return null;
    if (ref !== null) {
      while (t - ref > WRAP / 2) t -= WRAP;
      while (ref - t > WRAP / 2) t += WRAP;
    }
    ref = t;
    return t;
  };

  // Splits a TS segment into PES packets per PID, in order.
  function demux(d) {
    const pes = { video: [], audio: [] };
    const open = {};
    const close = (pid) => {
      const parts = open[pid];
      if (!parts?.length) return;
      const p = readPes(concat(parts));
      open[pid] = null;
      if (p) (pid === videoPid ? pes.video : pes.audio).push(p);
    };
    for (let at = 0; at + 188 <= d.length; at += 188) {
      if (d[at] !== 0x47) {
        // Lost sync: find the next packet start.
        const next = d.indexOf(0x47, at + 1);
        if (next < 0) break;
        at = next - 188;
        continue;
      }
      const start = d[at + 1] & 0x40;
      const pid = ((d[at + 1] & 0x1f) << 8) | d[at + 2];
      const afc = (d[at + 3] >> 4) & 3;
      if (!(afc & 1)) continue;
      const off = at + 4 + (afc & 2 ? 1 + d[at + 4] : 0);
      if (off >= at + 188) continue;
      const payload = d.subarray(off, at + 188);
      if (pid === 0 && start) {
        const s = payload.subarray(1 + payload[0]);
        const end = Math.min(s.length - 4, 3 + (((s[1] & 0xf) << 8) | s[2]) - 4);
        for (let i = 8; i + 4 <= end; i += 4) {
          if ((s[i] << 8) | s[i + 1]) pmt = ((s[i + 2] & 0x1f) << 8) | s[i + 3];
        }
      } else if (pid === pmt && start) {
        const s = payload.subarray(1 + payload[0]);
        const end = Math.min(s.length - 4, 3 + (((s[1] & 0xf) << 8) | s[2]) - 4);
        for (let i = 12 + (((s[10] & 0xf) << 8) | s[11]); i + 5 <= end; ) {
          const type = s[i];
          const epid = ((s[i + 1] & 0x1f) << 8) | s[i + 2];
          const infoLen = ((s[i + 3] & 0xf) << 8) | s[i + 4];
          const info = s.subarray(i + 5, i + 5 + infoLen);
          let audio = AUDIO_TYPES[type];
          if (type === 0x06) {
            // Private data: DVB marks AC-3 / E-AC-3 with a descriptor.
            for (let k = 0; k + 2 <= info.length; k += 2 + info[k + 1]) {
              if (info[k] === 0x6a) audio = 'ac3';
              if (info[k] === 0x7a) audio = 'eac3';
            }
          }
          if (VIDEO_TYPES[type] && videoPid === null) (videoPid = epid), (videoCodec = VIDEO_TYPES[type]);
          else if (audio && audioPid === null) (audioPid = epid), (audioKind = audio);
          i += 5 + infoLen;
        }
      } else if (pid === videoPid || pid === audioPid) {
        if (start) {
          close(pid);
          open[pid] = [];
        }
        open[pid]?.push(payload);
      }
    }
    close(videoPid);
    close(audioPid);
    return pes;
  }

  // Video samples: one per PES with a timestamp (later PES without one continue it).
  function videoSamples(pesList) {
    const samples = [];
    for (const p of pesList) {
      const units = nalUnits(p.payload);
      if (p.pts === null && samples.length) {
        samples[samples.length - 1].units.push(...units);
        continue;
      }
      if (p.pts === null) continue;
      samples.push({ pts: unwrap(p.pts), dts: unwrap(p.dts), units });
    }
    const out = [];
    for (const s of samples) {
      const kept = [];
      let sync = false;
      for (const n of s.units) {
        if (!n.length) continue;
        const type = videoCodec === 'h264' ? n[0] & 0x1f : (n[0] >> 1) & 0x3f;
        const names = videoCodec === 'h264' ? { 7: 'sps', 8: 'pps' } : { 32: 'vps', 33: 'sps', 34: 'pps' };
        if (names[type]) {
          const name = names[type];
          if (!params[name]) params[name] = n.slice();
          else if (initDone && !sameBytes(params[name], n)) paramsChanged = true;
          continue;
        }
        if (videoCodec === 'h264' ? type === 9 || type === 12 : type === 35 || type === 38) continue; // delimiters, filler
        if (videoCodec === 'h264' ? type === 5 : type >= 16 && type <= 21) sync = true;
        kept.push(n);
      }
      if (!kept.length) continue;
      const data = concat(kept.flatMap((n) => [u32(n.length), n]));
      out.push({ dts: s.dts, cto: s.pts - s.dts, data, sync });
    }
    for (let i = 0; i < out.length; i++) {
      out[i].duration = i + 1 < out.length ? out[i + 1].dts - out[i].dts : lastVideoDuration;
      if (i + 1 < out.length && out[i].duration > 0) lastVideoDuration = out[i].duration;
      if (out[i].duration <= 0) out[i].duration = lastVideoDuration;
    }
    return out;
  }

  // Audio frames from PES payloads (or a packed-audio segment), timed from the
  // PES timestamps and the frames' own lengths.
  function audioFrames(chunks) {
    const frames = [];
    let config = null;
    for (const { pts, payload } of chunks) {
      const d = audioLeft.length ? concat([audioLeft, payload]) : payload;
      // A timestamp applies to the first frame starting in this PES.
      if (pts !== null && !audioLeft.length) audioNext = unwrap(pts);
      let at = 0;
      while (at < d.length) {
        const f = FRAMES[audioKind](d, at);
        if (!f) {
          // Not a frame here: a frame cut by the PES end, or garbage to skip.
          const tail = d.length - at;
          if (tail < 8192 && looksLikeFrameStart(d, at)) break;
          at++;
          continue;
        }
        config ||= f;
        frames.push({ data: d.slice(at + f.skip, at + f.size), samples: f.samples, rate: f.rate, time: audioNext ?? 0 });
        audioNext = (audioNext ?? 0) + (f.samples * 90000) / f.rate;
        at += f.size;
      }
      audioLeft = d.slice(at);
    }
    return { frames, config };
  }

  const looksLikeFrameStart = (d, at) => (audioKind === 'aac' || audioKind === 'mpa' ? d[at] === 0xff : d[at] === 0x0b);

  function trackInit() {
    const traks = [];
    const trexes = [];
    let id = 0;
    for (const kind of ['video', 'audio']) {
      const t = tracks[kind];
      if (!t) continue;
      t.id = ++id;
      const isVideo = kind === 'video';
      traks.push(box('trak',
        full('tkhd', 0, 3, u32(0), u32(0), u32(t.id), u32(0), u32(0), new Uint8Array(8), u16(0), u16(isVideo ? 0 : 1), u16(isVideo ? 0 : 0x100), u16(0),
          ...[0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32), u32((t.width || 0) * 65536), u32((t.height || 0) * 65536)),
        box('mdia',
          full('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(0), u16(0x55c4), u16(0)),
          full('hdlr', 0, 0, u32(0), new TextEncoder().encode(isVideo ? 'vide' : 'soun'), new Uint8Array(12), new TextEncoder().encode(isVideo ? 'VideoHandler\0' : 'SoundHandler\0')),
          box('minf',
            isVideo ? full('vmhd', 0, 1, new Uint8Array(8)) : full('smhd', 0, 0, u32(0)),
            box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
            box('stbl', full('stsd', 0, 0, u32(1), t.entry), full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)), full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)))))));
      trexes.push(full('trex', 0, 0, u32(t.id), u32(1), u32(0), u32(0), u32(0)));
    }
    return concat([
      box('ftyp', new TextEncoder().encode('isom'), u32(512), new TextEncoder().encode('isomiso6mp41')),
      box('moov', full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), u32(0x10000), u16(0x100), new Uint8Array(10), ...[0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32), new Uint8Array(24), u32(id + 1)),
        ...traks, box('mvex', ...trexes)),
    ]);
  }

  // One moof + mdat for a track's samples ({ duration, size, sync, cto, data }).
  function fragment(t, baseTime, samples) {
    const flags = (s) => (s.sync ? 0x02000000 : 0x01010000);
    const trunBody = (offset) => [u32(samples.length), u32(offset), ...samples.flatMap((s) => [u32(s.duration), u32(s.data.length), u32(flags(s)), u32(s.cto || 0)])];
    const make = (offset) => box('moof', full('mfhd', 0, 0, u32(++sequence)),
      box('traf', full('tfhd', 0, 0x020000, u32(t.id)), full('tfdt', 1, 0, u64(baseTime)), full('trun', 0, 0xf01, ...trunBody(offset))));
    const size = make(0).length;
    sequence--;
    const moof = make(size + 8);
    return concat([moof, box('mdat', ...samples.map((s) => s.data))]);
  }

  return {
    push(d) {
      const parts = [];
      let video = [];
      let audio = { frames: [] };
      if (d[0] === 0x47) {
        const pes = demux(d);
        if (videoPid !== null) video = videoSamples(pes.video);
        if (audioPid !== null) audio = audioFrames(pes.audio);
      } else {
        // HLS packed audio: an ID3 tag with the timestamp, then raw audio frames.
        const { pts, end } = id3Timestamp(d);
        audioKind ||= sniffAudio(d, end);
        if (audioKind) audio = audioFrames([{ pts: pts ?? (audioNext === null ? 0 : null), payload: d.subarray(end) }]);
      }

      if (!tracks.video && video.length) {
        const ready = videoCodec === 'h264' ? params.sps && params.pps : params.vps && params.sps && params.pps;
        if (ready) tracks.video = { timescale: 90000, ...(videoCodec === 'h264' ? avcSampleEntry(params.sps, params.pps) : hevcSampleEntry(params.vps, params.sps, params.pps)) };
      }
      if (!tracks.audio && audio.config) {
        const c = audio.config;
        tracks.audio = { timescale: c.rate, entry: audioSampleEntry(c.config, c.rate, c.channels) };
      }
      const hasVideo = tracks.video && video.length;
      const hasAudio = tracks.audio && audio.frames.length;
      if (!hasVideo && !hasAudio) return null;
      let init = null;
      if (!initDone) {
        init = trackInit();
        initDone = true;
      }
      if (hasVideo) parts.push(fragment(tracks.video, video[0].dts, video));
      if (hasAudio) {
        const rate = tracks.audio.timescale;
        const samples = audio.frames.map((f) => ({ data: f.data, duration: f.samples, sync: true }));
        parts.push(fragment(tracks.audio, (audio.frames[0].time * rate) / 90000, samples));
      }
      return { init, data: concat(parts), changed: paramsChanged };
    },
    // After a discontinuity: timestamps jump, and nothing carries over.
    reset() {
      ref = null;
      audioNext = null;
      audioLeft = new Uint8Array(0);
    },
  };
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
