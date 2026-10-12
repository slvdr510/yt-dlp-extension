// Music in other formats than M4A: the AAC track is decoded with WebCodecs and
// written as MP3 (lamejs) or WAV, with the song details and cover where the
// format holds them. Browser only (uses AudioDecoder).

// The formats music can be saved in. 'm4a' and 'opus' are the site's own audio,
// unchanged; 'mp3' and 'wav' are converted from it.
export const AUDIO_FORMATS = ['m4a', 'mp3', 'opus', 'wav'];
const MP3_KBPS = 192; // above YouTube's ~128 kbps AAC, so the conversion loses little

// MPEG-4 descriptor lengths: 1 to 4 bytes, 7 bits each.
function descriptorLength(b, at) {
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const x = b[at++];
    len = (len << 7) | (x & 0x7f);
    if (!(x & 0x80)) break;
  }
  return { len, at };
}

// The decoder setup from a track's stsd box: { codec, sampleRate, numberOfChannels, description }.
export function aacConfig(stsd) {
  const v = new DataView(stsd.buffer, stsd.byteOffset, stsd.byteLength);
  const entry = 16; // box header, version and flags, entry count
  if (String.fromCharCode(...stsd.subarray(entry + 4, entry + 8)) !== 'mp4a') return null;
  const numberOfChannels = v.getUint16(entry + 24);
  const sampleRate = v.getUint32(entry + 32) >>> 16;
  // esds: ES_Descriptor (3) > DecoderConfigDescriptor (4) > DecoderSpecificInfo (5) = AudioSpecificConfig.
  for (let i = entry + 36; i < stsd.length - 8; i++) {
    if (String.fromCharCode(...stsd.subarray(i, i + 4)) !== 'esds') continue;
    let at = i + 8;
    while (at < stsd.length) {
      const tag = stsd[at];
      const { len, at: body } = descriptorLength(stsd, at + 1);
      if (tag === 3) {
        // ES_ID, flags, then the optional fields the flags announce.
        const flags = stsd[body + 2];
        at = body + 3;
        if (flags & 0x80) at += 2;
        if (flags & 0x40) at += 1 + stsd[at];
        if (flags & 0x20) at += 2;
      } else if (tag === 4) at = body + 13;
      else if (tag === 5) {
        const description = stsd.slice(body, body + len);
        const objectType = description[0] >> 3;
        return { codec: `mp4a.40.${objectType}`, sampleRate, numberOfChannels, description };
      } else at = body + len;
    }
  }
  return null;
}

// Reads a track's samples in large contiguous pieces: [{ data, duration }].
async function* sampleData(blob, samples, signal) {
  for (let i = 0; i < samples.length; ) {
    signal?.throwIfAborted();
    if (samples[i].data) {
      yield samples[i++];
      continue;
    }
    let j = i;
    let end = samples[i].offset + samples[i].size;
    while (j + 1 < samples.length && !samples[j + 1].data && samples[j + 1].offset === end && end - samples[i].offset < 1 << 20) end += samples[++j].size;
    const bytes = new Uint8Array(await blob.slice(samples[i].offset, end).arrayBuffer());
    for (let k = i; k <= j; k++) yield { data: bytes.subarray(samples[k].offset - samples[i].offset, samples[k].offset - samples[i].offset + samples[k].size), duration: samples[k].duration };
    i = j + 1;
  }
}

// Decodes an AAC track (from readTracks) to 16-bit PCM. `onPcm(channels, sampleRate)`
// gets each piece as one Int16Array per channel (at most two: more are mixed down).
async function decode(track, blob, { signal, onPcm, onProgress }) {
  const config = aacConfig(track.stsd);
  if (!config || !(await AudioDecoder.isConfigSupported(config)).supported) throw new Error('This browser can’t decode the audio to convert it.');
  let failure = null;
  const decoder = new AudioDecoder({
    output: (audio) => {
      try {
        const frames = audio.numberOfFrames;
        const count = Math.min(2, audio.numberOfChannels);
        const channels = [];
        for (let c = 0; c < count; c++) {
          const f32 = new Float32Array(frames);
          audio.copyTo(f32, { planeIndex: c, format: 'f32-planar' });
          const s16 = new Int16Array(frames);
          for (let i = 0; i < frames; i++) s16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
          channels.push(s16);
        }
        onPcm(channels, audio.sampleRate);
      } catch (e) {
        failure ||= e;
      } finally {
        audio.close();
      }
    },
    error: (e) => (failure ||= e),
  });
  decoder.configure(config);
  const total = track.samples.length;
  let done = 0;
  let time = 0;
  try {
    for await (const s of sampleData(blob, track.samples, signal)) {
      if (failure) throw failure;
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((time / track.timescale) * 1e6), data: s.data }));
      time += s.duration;
      if (++done % 200 === 0) onProgress?.(done, total);
      // Don't run ahead of the decoder (memory), and let the encoder work in between.
      while (decoder.decodeQueueSize > 64) await new Promise((r) => decoder.addEventListener('dequeue', r, { once: true }));
    }
    await decoder.flush();
    if (failure) throw failure;
    onProgress?.(total, total);
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
}

const utf16 = (s) => {
  const out = new Uint8Array(2 + s.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < s.length; i++) (out[2 + i * 2] = s.charCodeAt(i) & 0xff), (out[3 + i * 2] = s.charCodeAt(i) >> 8);
  return out;
};
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
};

// An ID3v2.3 tag (what every player reads) with the song details and cover.
// meta: { title, artist, album, date, url, cover: { bytes, type } }.
export function id3(meta = {}) {
  const frames = [];
  const frame = (id, body) => {
    const head = new Uint8Array(10);
    head.set(ascii(id));
    new DataView(head.buffer).setUint32(4, body.length);
    frames.push(head, body);
  };
  const text = (id, value) => value && frame(id, concat([Uint8Array.of(1), utf16(String(value))]));
  text('TIT2', meta.title);
  text('TPE1', meta.artist);
  text('TALB', meta.album);
  text('TYER', (meta.date || '').slice(0, 4));
  if (meta.url) frame('WXXX', concat([Uint8Array.of(0, 0), ascii(meta.url)]));
  if (meta.cover?.bytes) frame('APIC', concat([Uint8Array.of(0), ascii(`image/${meta.cover.type === 'png' ? 'png' : 'jpeg'}`), Uint8Array.of(0, 3, 0), meta.cover.bytes]));
  const body = concat(frames);
  const n = body.length;
  // The tag size is "syncsafe": 7 bits per byte.
  const head = Uint8Array.of(0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f);
  return concat([head, body]);
}

// A WAV header for 16-bit PCM, with the song details in a LIST/INFO chunk.
export function wavHeader({ sampleRate, channels, dataSize, meta = {} }) {
  const info = [];
  const field = (id, value) => {
    if (!value) return;
    const bytes = new TextEncoder().encode(`${value}\0`);
    const chunk = new Uint8Array(8 + bytes.length + (bytes.length & 1));
    chunk.set(ascii(id));
    new DataView(chunk.buffer).setUint32(4, bytes.length, true);
    chunk.set(bytes, 8);
    info.push(chunk);
  };
  field('INAM', meta.title);
  field('IART', meta.artist);
  field('IPRD', meta.album);
  field('ICRD', meta.date);
  const list = info.length ? concat([ascii('LIST'), new Uint8Array(4), ascii('INFO'), ...info]) : new Uint8Array(0);
  if (list.length) new DataView(list.buffer).setUint32(4, list.length - 8, true);
  const head = new Uint8Array(36);
  const v = new DataView(head.buffer);
  head.set(ascii('RIFF'));
  v.setUint32(4, 4 + 24 + list.length + 8 + dataSize, true);
  head.set(ascii('WAVEfmt '), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  const data = new Uint8Array(8);
  data.set(ascii('data'));
  new DataView(data.buffer).setUint32(4, dataSize, true);
  return concat([head, list, data]);
}

// Converts an AAC track to `format` ('mp3' or 'wav'). Resolves to a Blob.
export async function convertAudio(format, { track, blob, meta, signal, onProgress }) {
  const parts = [];
  let channels = 0;
  let sampleRate = 0;
  let encoder = null;
  if (format === 'mp3') {
    const { Mp3Encoder } = await import('../vendor/lamejs.js');
    await decode(track, blob, {
      signal,
      onProgress,
      onPcm: (pcm, rate) => {
        encoder ||= ((channels = pcm.length), (sampleRate = rate), new Mp3Encoder(channels, rate, MP3_KBPS));
        const out = encoder.encodeBuffer(pcm[0], pcm[1]);
        if (out.length) parts.push(new Uint8Array(out.buffer, out.byteOffset, out.length).slice());
      },
    });
    if (!encoder) throw new Error('The audio track is empty.');
    const end = encoder.flush();
    if (end.length) parts.push(new Uint8Array(end.buffer, end.byteOffset, end.length).slice());
    return new Blob([id3(meta), ...parts], { type: 'audio/mpeg' });
  }
  if (format === 'wav') {
    let size = 0;
    await decode(track, blob, {
      signal,
      onProgress,
      onPcm: (pcm, rate) => {
        channels ||= pcm.length;
        sampleRate ||= rate;
        // WAV interleaves the channels.
        const frames = pcm[0].length;
        const out = new Int16Array(frames * channels);
        for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) out[i * channels + c] = (pcm[c] || pcm[0])[i];
        parts.push(new Uint8Array(out.buffer));
        size += out.byteLength;
      },
    });
    if (!channels) throw new Error('The audio track is empty.');
    return new Blob([wavHeader({ sampleRate, channels, dataSize: size, meta }), ...parts], { type: 'audio/wav' });
  }
  throw new Error(`Unknown audio format: ${format}`);
}
