// Builds the zip to share: dist/yt-dlp-downloader-<version>-yt-dlp-<yt-dlp version>.zip.
// It contains the extension folder, with the pinned yt-dlp and Pyodide inside.
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const versions = JSON.parse(readFileSync(join(ROOT, 'versions.json'), 'utf8'));
const vendorFile = join(EXT, 'vendor/vendor.json');
if (!existsSync(vendorFile)) throw new Error('extension/vendor is missing: run npm run vendor first');
const vendor = JSON.parse(readFileSync(vendorFile, 'utf8'));
if (vendor['yt-dlp'] !== versions['yt-dlp'] || vendor.pyodide !== versions.pyodide) {
  throw new Error(`extension/vendor has yt-dlp ${vendor['yt-dlp']} / Pyodide ${vendor.pyodide}, versions.json wants ${versions['yt-dlp']} / ${versions.pyodide}: run npm run vendor`);
}
const dist = join(ROOT, 'dist');
mkdirSync(dist, { recursive: true });
const name = `yt-dlp-downloader-${manifest.version}-yt-dlp-${versions['yt-dlp']}.zip`;
rmSync(join(dist, name), { force: true });
// The zip holds a folder named after the release, ready for "Load unpacked".
const folder = name.replace(/\.zip$/, '');
const stage = join(dist, folder);
rmSync(stage, { recursive: true, force: true });
execFileSync('cp', ['-r', EXT, stage]);
execFileSync('zip', ['-q', '-r', '-X', name, folder], { cwd: dist });
rmSync(stage, { recursive: true, force: true });
console.log(join('dist', name));
