// Puts the pinned yt-dlp (plus the yt-dlp-ejs version it expects) and Pyodide
// into extension/vendor. Run after changing versions.json: `npm run vendor`.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'extension/vendor');
const versions = JSON.parse(readFileSync(join(ROOT, 'versions.json'), 'utf8'));

// The pure-Python wheel of `name` at `version` from PyPI, checked against its sha256.
async function wheel(name, version) {
  const meta = await (await fetch(`https://pypi.org/pypi/${name}/${version}/json`)).json();
  const file = meta.urls.find((u) => u.packagetype === 'bdist_wheel' && u.filename.endsWith('-py3-none-any.whl'));
  if (!file) throw new Error(`No pure-Python wheel for ${name} ${version}`);
  const bytes = Buffer.from(await (await fetch(file.url)).arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== file.digests.sha256) throw new Error(`Checksum mismatch for ${file.filename}`);
  return { filename: file.filename, bytes };
}

// Reads one file out of a zip (wheels are zips).
function unzipFile(zip, path) {
  for (let at = 0; at < zip.length - 4; ) {
    if (zip.readUInt32LE(at) !== 0x04034b50) break;
    const method = zip.readUInt16LE(at + 8);
    const size = zip.readUInt32LE(at + 18);
    const nameLen = zip.readUInt16LE(at + 26);
    const extraLen = zip.readUInt16LE(at + 28);
    const name = zip.toString('utf8', at + 30, at + 30 + nameLen);
    const start = at + 30 + nameLen + extraLen;
    if (name === path) {
      const data = zip.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    at = start + size;
  }
  throw new Error(`${path} not found in wheel`);
}

rmSync(VENDOR, { recursive: true, force: true });
mkdirSync(join(VENDOR, 'pyodide'), { recursive: true });
mkdirSync(join(VENDOR, 'wheels'), { recursive: true });

const pyodideDir = join(ROOT, 'node_modules/pyodide');
const installed = JSON.parse(readFileSync(join(pyodideDir, 'package.json'), 'utf8')).version;
if (installed !== versions.pyodide) throw new Error(`node_modules has Pyodide ${installed}, versions.json wants ${versions.pyodide}: run npm install`);
for (const f of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) copyFileSync(join(pyodideDir, f), join(VENDOR, 'pyodide', f));

const ytdlp = await wheel('yt-dlp', versions['yt-dlp']);
// yt-dlp checks the challenge-solver scripts against the yt-dlp-ejs version it was released with.
const ejsVersion = unzipFile(ytdlp.bytes, 'yt_dlp/extractor/youtube/jsc/_builtin/vendor/_info.py').match(/VERSION\s*=\s*'([^']+)'/)[1];
const ejs = await wheel('yt-dlp-ejs', ejsVersion);
for (const w of [ytdlp, ejs]) writeFileSync(join(VENDOR, 'wheels', w.filename), w.bytes);
const manifest = { 'yt-dlp': versions['yt-dlp'], 'yt-dlp-ejs': ejsVersion, pyodide: versions.pyodide, wheels: [ytdlp.filename, ejs.filename] };
writeFileSync(join(VENDOR, 'vendor.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(manifest);
