// Service worker: routes the popup's requests to the engine (an offscreen
// document running yt-dlp) and owns the downloads.

let creating = null;

async function hasEngine() {
  return (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
}

async function ensureEngine() {
  if (await hasEngine()) return;
  creating ||= chrome.offscreen
    .createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Runs yt-dlp and joins downloaded video, audio and subtitles into one file.' })
    .finally(() => (creating = null));
  await creating;
}

// Sends a command to the engine; retries while it's still starting.
async function toEngine(msg) {
  await ensureEngine();
  for (let i = 0; i < 50; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'engine', ...msg });
      if (res !== undefined) return res;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("The download engine didn't start.");
}

// Requests from the engine.
const engineHandlers = {
  addRule: async ({ rule }) => (await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] }), { ok: true }),
  removeRules: async ({ ids }) => (await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }), { ok: true }),
};

const handlers = {
  analyze: (msg) => toEngine({ cmd: 'analyze', url: msg.url, playlist: !!msg.playlist }),
  versions: () => toEngine({ cmd: 'versions' }),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === 'engine') return;
  const handler = (msg.target === 'worker' ? engineHandlers : handlers)[msg.cmd];
  if (!handler) return;
  handler(msg).then(reply, (e) => reply({ error: e.message }));
  return true;
});
