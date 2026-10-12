// Downloading a single file (not a stream) robustly. Pure logic, no UI, so it
// can be tested outside the browser.

const MAX_RESUMES = 5;

// Total size from Content-Range ("bytes 0-99/1234"), else Content-Length of a full answer.
function totalOf(r, offset) {
  const range = r.headers.get('content-range')?.match(/\/(\d+)\s*$/);
  if (range) return Number(range[1]);
  const length = Number(r.headers.get('content-length')) || 0;
  return length ? offset + length : 0;
}

// Fetches `url` into `sink`. It always asks for a range ("bytes=N-"): servers that
// only answer range requests accept it, the others ignore it and send the whole
// file. When the server supports ranges it keeps asking until it has every byte,
// so a dropped connection resumes where it stopped and servers that answer a
// range only in part (some CDNs cap each answer) still give the whole file.
// Resolves to the number of bytes written.
// With `chunkSize`, each request asks for at most that many bytes (some sites,
// YouTube among them, throttle requests for a whole large file). `headers` are
// sent with every request.
export async function downloadFile({ url, sink, signal, onProgress, size = 0, chunkSize = 0, headers = {} }) {
  let bytes = 0;
  let total = size;
  let resumes = 0;
  for (;;) {
    let r;
    try {
      const end = chunkSize ? bytes + chunkSize - 1 : '';
      r = await fetch(url, { credentials: 'include', signal, headers: { ...headers, Range: `bytes=${bytes}-${end}` } });
    } catch (e) {
      if (signal?.aborted || !bytes || ++resumes > MAX_RESUMES) throw e;
      await pause(resumes, signal);
      continue;
    }
    if (r.status === 416 && total && bytes >= total) break; // asked past the end: nothing left
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    const partial = r.status === 206;
    if (bytes && !partial) throw new Error('The connection dropped and the server can’t resume the download.');
    if (partial && Number(r.headers.get('content-range')?.match(/bytes (\d+)-/)?.[1] ?? bytes) !== bytes) {
      throw new Error('The server answered with the wrong part of the file.');
    }
    total = totalOf(r, bytes) || total;

    const before = bytes;
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await sink.write(value);
        bytes += value.byteLength;
        onProgress?.({ done: bytes, total: total || bytes + 1, bytes });
      }
    } catch (e) {
      if (signal?.aborted || !partial || ++resumes > MAX_RESUMES) throw e;
      await pause(resumes, signal);
      continue;
    }
    // Done: a full answer, or the whole size is here (or unknown and nothing more came).
    if (!partial || !total || bytes >= total || bytes === before) break;
  }
  if (total && bytes < total) throw new Error(`The download stopped early (${bytes} of ${total} bytes).`);
  onProgress?.({ done: bytes, total: bytes, bytes });
  return bytes;
}

function pause(attempt, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, 500 * 2 ** (attempt - 1));
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
}
