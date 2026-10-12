// Downloads one of yt-dlp's formats into a temporary file, whatever its protocol.
import { downloadFile } from '../lib/net.js';
import { createSink } from '../lib/sink.js';
import { parsePlaylist, downloadTrack, fetchText } from '../lib/hls.js';

// The protocols the extension can download (format selection skips the others).
export const PROTOCOLS = ['https', 'http', 'm3u8_native', 'm3u8', 'http_dash_segments'];

// Request headers fetch() may send itself; the rest (User-Agent, Referer, Origin)
// need a header rule from the caller.
const RULE_HEADERS = ['user-agent', 'referer', 'origin'];
const SKIP_HEADERS = ['cookie', 'host', 'content-length', 'connection', 'accept-encoding'];

export function splitHeaders(headers = {}) {
  const plain = {};
  const ruled = {};
  for (const [k, v] of Object.entries(headers)) {
    const n = k.toLowerCase();
    if (SKIP_HEADERS.includes(n)) continue;
    (RULE_HEADERS.includes(n) ? ruled : plain)[n] = v;
  }
  return { plain, ruled };
}

const hostsOf = (urls) => [...new Set(urls.map((u) => new URL(u).hostname))];

// Downloads `format` (a yt-dlp format dict). `rules(hosts, headers)` must make
// the browser send `headers` to those hosts until the returned function is called.
// Resolves to { blob, cleanup, ext, index, mp4 }: the file, how to delete it, its
// extension, and for MP4 output the top-level boxes written (when known).
export async function downloadFormat(format, { signal, onProgress, rules }) {
  const { plain, ruled } = splitHeaders(format.http_headers);
  const protocol = format.protocol || 'https';
  const sink = await createSink();
  const progress = (done, total, bytes) => onProgress?.({ done, total, bytes });
  let release = async () => {};
  try {
    if (protocol === 'https' || protocol === 'http') {
      release = await rules(hostsOf([format.url]), ruled);
      const size = format.filesize || format.filesize_approx || 0;
      const chunkSize = format.downloader_options?.http_chunk_size || 0;
      await downloadFile({ url: format.url, sink, signal, size, chunkSize, headers: plain, onProgress: ({ done, total, bytes }) => progress(done, total, bytes) });
      const { blob, cleanup } = await sink.finish();
      return { blob, cleanup, ext: format.ext, mp4: ['mp4', 'm4a', 'mov'].includes(format.ext) };
    }

    if (protocol.startsWith('m3u8')) {
      const playlistUrl = format.url;
      release = await rules(hostsOf([playlistUrl]), ruled);
      const { text, url } = await fetchText(playlistUrl, signal);
      const media = parsePlaylist(text, url);
      if (!media.segments.length) throw new Error('The stream has no segments.');
      await release();
      release = await rules(hostsOf([url, ...media.segments.flatMap((s) => [s.uri, s.key?.uri, s.map?.uri].filter(Boolean))]), ruled);
      const result = await downloadTrack({
        segments: media.segments,
        convert: !media.segments.some((s) => s.map),
        sink,
        signal,
        muxjs: globalThis.muxjs,
        onProgress: ({ done, total, bytes }) => progress(done, total, bytes),
      });
      const { blob, cleanup } = await sink.finish();
      const audioOnly = format.vcodec === 'none';
      return { blob, cleanup, ext: result.mp4 ? (audioOnly ? 'm4a' : 'mp4') : 'ts', mp4: result.mp4, index: result.index };
    }

    if (protocol === 'http_dash_segments') {
      const urls = (format.fragments || []).map((f) => f.url || new URL(f.path, format.fragment_base_url).href);
      if (!urls.length) throw new Error('The stream has no segments.');
      release = await rules(hostsOf(urls), ruled);
      let bytes = 0;
      for (let i = 0; i < urls.length; i++) {
        const data = await fetchRetry(urls[i], plain, signal);
        await sink.write(data);
        bytes += data.byteLength;
        progress(i + 1, urls.length, bytes);
      }
      const { blob, cleanup } = await sink.finish();
      return { blob, cleanup, ext: format.ext, mp4: ['mp4', 'm4a'].includes(format.ext) };
    }

    throw new Error(`Streams of type "${protocol}" aren't supported yet.`);
  } catch (e) {
    await sink.abort?.();
    throw e;
  } finally {
    await release();
  }
}

async function fetchRetry(url, headers, signal, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { credentials: 'include', headers, signal });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} from ${new URL(url).hostname}`), { status: r.status });
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (signal?.aborted || i >= tries || [401, 403, 404, 410].includes(e.status)) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (i - 1)));
    }
  }
}
