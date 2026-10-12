import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
const EXT = resolve('spike/ext');
const profile = mkdtempSync(join(tmpdir(), 'ytx-profile-'));
const proc = spawn(chromium.executablePath(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const ep = await new Promise((r) => { let e = ''; proc.stderr.on('data', (d) => { e += d; const m = e.match(/DevTools listening on (ws:\/\/\S+)/); if (m) r(m[1]); }); });
try {
  const browser = await chromium.connectOverCDP(ep);
  const ctx = browser.contexts()[0];
  // Unpacked extensions get an ID derived from their folder path.
  const extId = [...createHash('sha256').update(EXT).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`chrome-extension://${extId}/spike.html?url=${encodeURIComponent(process.argv[2])}`);
  await page.waitForFunction(() => globalThis.result, null, { timeout: 180000 });
  console.log(JSON.stringify(await page.evaluate(() => globalThis.result), null, 1));
  await browser.close();
} finally {
  proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(profile, { recursive: true, force: true });
}
