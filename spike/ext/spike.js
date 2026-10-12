import { loadPyodide } from './pyodide/pyodide.mjs';
const log = (...a) => (document.getElementById('log').textContent += a.join(' ') + '\n');
const FORBIDDEN = ['user-agent', 'origin', 'referer'];
const DROP = ['cookie', 'host', 'content-length', 'connection', 'accept-encoding'];
let ruleId = 1;
globalThis.lvFetch = async (url, method, headers, body, timeout) => {
  const set = [];
  const pass = {};
  for (const [k, v] of Object.entries(headers)) {
    const n = k.toLowerCase();
    if (DROP.includes(n)) continue;
    if (FORBIDDEN.includes(n)) set.push({ header: n, operation: 'set', value: v });
    else pass[k] = v;
  }
  const id = ruleId++;
  if (set.length) {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{ id, priority: 1, action: { type: 'modifyHeaders', requestHeaders: set }, condition: { requestDomains: [new URL(url).hostname], initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] } }],
    });
  }
  try {
    const r = await fetch(url, { method, headers: pass, body: body ?? undefined, credentials: 'include', signal: AbortSignal.timeout(timeout * 1000) });
    const buf = new Uint8Array(await r.arrayBuffer());
    globalThis.requests.push(`${method} ${r.status} ${url.slice(0, 90)}`);
    return { status: r.status, url: r.url, headers: Object.fromEntries(r.headers), body: buf };
  } finally {
    if (set.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  }
};
globalThis.requests = [];
const pending = new Map();
let jsId = 0;
addEventListener('message', (e) => pending.get(e.data.id)?.(e.data));
globalThis.lvRunJs = (code) => new Promise((resolve) => {
  const id = ++jsId;
  pending.set(id, resolve);
  document.getElementById('box').contentWindow.postMessage({ id, code }, '*');
});

(async () => {
  const t0 = performance.now();
  const py = await loadPyodide({ indexURL: new URL('./pyodide/', location.href).href });
  for (const w of ['yt_dlp-2026.8.19-py3-none-any.whl', 'yt_dlp_ejs-0.8.0-py3-none-any.whl']) {
    py.unpackArchive(await (await fetch(`wheels/${w}`)).arrayBuffer(), 'wheel');
  }
  py.runPython(await (await fetch('glue.py')).text());
  const t1 = performance.now();
  const url = new URLSearchParams(location.search).get('url');
  py.globals.set('target', url);
  try {
    const out = await py.runPythonAsync(`
import json
from yt_dlp import YoutubeDL
msgs = []
class L:
    def debug(self, m): msgs.append(m)
    def info(self, m): msgs.append(m)
    def warning(self, m): msgs.append('WARN ' + m)
    def error(self, m): msgs.append('ERR ' + m)
with YoutubeDL({'js_runtimes': {'browser': {}}, 'logger': L(), 'verbose': True}) as ydl:
    info = ydl.extract_info(target, download=False)
fmts = info.get('formats') or []
json.dumps({'title': info.get('title'), 'formats': len(fmts), 'subs': list((info.get('subtitles') or {}).keys()),
            'auto': len(info.get('automatic_captions') or {}), 'categories': info.get('categories'),
            'best': [f.get('format_id') for f in fmts if f.get('url')][-3:],
            'urls': [f['url'] for f in fmts if f.get('url') and f.get('vcodec') != 'none' and f.get('protocol') == 'https'][-2:],
            'log': [m[:160] for m in msgs if 'WARN' in m or 'ERR' in m or 'challenge' in m.lower() or 'jsc' in m.lower() or 'player' in m.lower() or 'client' in m.lower()][:40]})
`);
    const r = JSON.parse(out);
    // Do the deciphered URLs really download?
    r.check = [];
    for (const u of r.urls) {
      const res = await fetch(u, { headers: { Range: 'bytes=0-1023' } });
      r.check.push(res.status);
    }
    delete r.urls;
    r.timing = { load: Math.round(t1 - t0), extract: Math.round(performance.now() - t1) };
    r.requests = globalThis.requests.length;
    globalThis.result = r;
  } catch (e) {
    globalThis.result = { error: String(e).slice(-3000), requests: globalThis.requests.slice(-15) };
  }
  log(JSON.stringify(globalThis.result, null, 1));
})();
