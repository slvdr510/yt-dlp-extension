// The engine: runs yt-dlp and the downloads in an offscreen document, so they
// keep going when the popup closes. Everything else goes through the worker.
import { extract, ytdlp } from './engine/ytdlp.js';
import { summarize } from './engine/summary.js';

// Extractions are reused for a few minutes: the popup analyzes, then downloads.
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // key -> { at, info }

async function info(url, options = {}) {
  const key = JSON.stringify([url, options]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const result = await extract(url, options);
  cache.set(key, { at: Date.now(), info: result });
  return result;
}

const handlers = {
  async analyze({ url, playlist }) {
    return { summary: summarize(await info(url, { playlist })) };
  },
  async versions() {
    return (await ytdlp()).versions;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target !== 'engine') return;
  const handler = handlers[msg.cmd];
  if (!handler) return;
  handler(msg).then(reply, (e) => reply({ error: e.message }));
  return true;
});

ytdlp(); // start loading right away
