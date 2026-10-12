// yt-dlp running in Pyodide (Python compiled to WebAssembly), loaded once and
// kept warm. Python waits on the browser's async work through JSPI (run_sync).
import { loadPyodide } from '../vendor/pyodide/pyodide.mjs';

// Request headers fetch() isn't allowed to set: session rules set them instead,
// only for this extension's request to that host, while the request runs.
const RULE_HEADERS = ['user-agent', 'origin', 'referer'];
// Left to the browser: cookies (its own, so logins work), and the transport ones.
const SKIP_HEADERS = ['cookie', 'host', 'content-length', 'connection', 'accept-encoding'];
let nextRule = 1_000_000;

const toWorker = async (msg) => {
  const res = await chrome.runtime.sendMessage({ target: 'worker', ...msg });
  if (res?.error) throw new Error(res.error);
  return res;
};

// Pause between yt-dlp's requests (seconds), so sites aren't hammered. Set from the settings.
let requestGap = 0;
let lastRequest = 0;
export function setRequestGap(seconds) {
  requestGap = Math.max(0, Number(seconds) || 0);
}

// Whether the browser's cookies (the user's logins) go with yt-dlp's requests.
let withCookies = true;
export function useCookies(on) {
  withCookies = !!on;
}

async function bridgeFetch(url, method, headers, body, timeout) {
  const wait = lastRequest + requestGap * 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const set = [];
  const pass = {};
  for (const [k, v] of Object.entries(headers)) {
    const name = k.toLowerCase();
    if (SKIP_HEADERS.includes(name)) continue;
    if (RULE_HEADERS.includes(name)) set.push({ header: name, operation: 'set', value: v });
    else pass[k] = v;
  }
  const id = nextRule++;
  // Offscreen documents have no declarativeNetRequest: the worker adds the rule.
  if (set.length) await toWorker({ cmd: 'addRule', rule: { id, priority: 2, action: { type: 'modifyHeaders', requestHeaders: set }, condition: { requestDomains: [new URL(url).hostname], initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] } } });
  try {
    const r = await fetch(url, { method, headers: pass, body: body ?? undefined, credentials: withCookies ? 'include' : 'omit', signal: AbortSignal.timeout(timeout * 1000) });
    return { status: r.status, url: r.url, headers: Object.fromEntries(r.headers), body: new Uint8Array(await r.arrayBuffer()) };
  } finally {
    if (set.length) await toWorker({ cmd: 'removeRules', ids: [id] });
  }
}

// Runs a script in the sandboxed page (jsbox.html) and resolves to { out, err }.
const box = (() => {
  const frame = document.createElement('iframe');
  frame.src = 'jsbox.html';
  frame.hidden = true;
  const loaded = new Promise((r) => (frame.onload = r));
  document.body.append(frame);
  const pending = new Map();
  let next = 0;
  addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow) return;
    pending.get(e.data.id)?.(e.data);
    pending.delete(e.data.id);
  });
  return async (code) => {
    await loaded;
    const id = ++next;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      frame.contentWindow.postMessage({ id, code }, '*');
    });
  };
})();

globalThis.bridgeFetch = bridgeFetch;
globalThis.bridgeRunJs = box;

let ready = null;

async function boot() {
  const base = new URL('../vendor/', import.meta.url);
  const py = await loadPyodide({ indexURL: new URL('pyodide/', base).href });
  const vendor = await (await fetch(new URL('vendor.json', base))).json();
  for (const w of vendor.wheels) py.unpackArchive(await (await fetch(new URL(`wheels/${w}`, base))).arrayBuffer(), 'wheel');
  py.runPython(await (await fetch(new URL('glue.py', import.meta.url))).text());
  return { py, extract: py.globals.get('extract'), versions: vendor };
}

// Loads yt-dlp (once).
export function ytdlp() {
  ready ||= boot().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

// Extracts a URL. Resolves to yt-dlp's info dict; throws with yt-dlp's message on failure.
export async function extract(url, { format, playlist = false } = {}) {
  const { py, extract: run } = await ytdlp();
  py.globals.set('_args', [url, JSON.stringify({ format, playlist })]);
  const out = JSON.parse(await py.runPythonAsync('extract(*_args)'));
  if (out.error) throw Object.assign(new Error(cleanError(out.error)), { log: out.log });
  return out.info;
}

// yt-dlp errors start with "ERROR: [extractor] id: ".
const cleanError = (msg) => msg.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[^:]+:\s*/, '');
