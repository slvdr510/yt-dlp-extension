// Copies the extension to dist/extension and keeps it in sync while it runs.
// Load dist/extension with "Load unpacked"; after a change, reload it in chrome://extensions.
import { cpSync, rmSync, existsSync, watch } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const OUT = join(ROOT, 'dist/extension');
if (!existsSync(join(EXT, 'vendor/vendor.json'))) console.warn('extension/vendor is missing: run npm run vendor');

rmSync(OUT, { recursive: true, force: true });
cpSync(EXT, OUT, { recursive: true });
console.log(`${OUT} ready, watching extension/ for changes`);

// Editors often fire several events per save: sync each path once they settle.
const pending = new Set();
let timer;
function sync() {
  for (const path of pending) {
    const src = join(EXT, path);
    const dest = join(OUT, path);
    if (existsSync(src)) cpSync(src, dest, { recursive: true });
    else rmSync(dest, { recursive: true, force: true });
    console.log(`${new Date().toLocaleTimeString()} ${existsSync(src) ? 'copied' : 'removed'} ${path}`);
  }
  pending.clear();
}
watch(EXT, { recursive: true }, (_event, path) => {
  if (!path) return;
  pending.add(path);
  clearTimeout(timer);
  timer = setTimeout(sync, 100);
});
