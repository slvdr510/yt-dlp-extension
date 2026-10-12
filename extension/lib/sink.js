// Where a download is written while it's being built. No UI, so it can be
// tested outside the browser.

const TEMP_PREFIX = 'lv-';
const TEMP_MAX_AGE = 24 * 3600 * 1000;
const BATCH = 4 * 1024 * 1024;

// A temporary file in the origin-private file system (OPFS), so large downloads go
// to disk instead of memory. Falls back to memorySink() if OPFS isn't available.
// A sink has write(chunk), finish() -> { blob, cleanup } and abort().
export async function createSink(storage = globalThis.navigator?.storage) {
  try {
    const root = await storage.getDirectory();
    const name = `${TEMP_PREFIX}${Date.now()}-${crypto.randomUUID()}`;
    const handle = await root.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    const remove = () => root.removeEntry(name).catch(() => {});
    return {
      write: (chunk) => writable.write(chunk),
      async finish() {
        await writable.close();
        return { blob: await handle.getFile(), cleanup: remove };
      },
      async abort() {
        await writable.abort().catch(() => {});
        remove();
      },
    };
  } catch (e) {
    return memorySink();
  }
}

// Without OPFS: chunks are packed into Blobs of a few MB as they arrive, so they
// leave the page's memory (the browser keeps blob data apart and moves large
// amounts of it to disk) instead of piling up until the download ends.
export function memorySink(batch = BATCH) {
  let pending = [];
  let pendingBytes = 0;
  const blobs = [];
  const pack = () => {
    if (!pending.length) return;
    blobs.push(new Blob(pending));
    pending = [];
    pendingBytes = 0;
  };
  return {
    blobs, // for tests
    async write(chunk) {
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      if (pendingBytes >= batch) pack();
    },
    async finish() {
      pack();
      return { blob: new Blob(blobs), cleanup() {} };
    },
    async abort() {
      pending = [];
      blobs.length = 0;
    },
  };
}

// Removes temporary files older than a day (left by downloads that were cut off).
export async function cleanupTemp(storage = globalThis.navigator?.storage) {
  try {
    const root = await storage.getDirectory();
    for await (const name of root.keys()) {
      const time = Number(name.slice(TEMP_PREFIX.length).split('-')[0]);
      if (name.startsWith(TEMP_PREFIX) && Date.now() - time > TEMP_MAX_AGE) root.removeEntry(name).catch(() => {});
    }
  } catch (e) {}
}
