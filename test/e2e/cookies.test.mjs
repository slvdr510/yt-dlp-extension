import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { startServer, launch } from './harness.mjs';
import { OUT } from '../fixtures/make.mjs';

let server, b;
const seen = [];
before(async () => {
  server = await startServer();
  // /private-NAME.html only answers when the request carries the cookie NAME=yes.
  server.hooks.push((req, res, url) => {
    const m = url.pathname.match(/^\/private-(\w+)\.html$/);
    if (!m) return false;
    seen.push({ page: m[1], cookie: req.headers.cookie || '' });
    if (!new RegExp(`(^|; )${m[1]}=yes(;|$)`).test(req.headers.cookie || '')) {
      res.writeHead(403).end('forbidden');
      return true;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Private</title><video src="/clip.mp4"></video>');
    return true;
  });
  b = await launch();
});
after(async () => {
  await b?.close();
  await server?.close();
});

const file = (path) => ({ name: basename(path), data: readFileSync(join(OUT, 'cookies', path)).toString('base64') });
const importCookies = (kind, paths) => b.send({ cmd: 'importCookies', kind, files: paths.map(file) });
const analyze = (name) => b.send({ cmd: 'analyze', url: `${server.base}/private-${name}.html` });

test('a cookies.txt file logs in', async () => {
  const r = await importCookies('txt', ['cookies.txt']);
  assert.equal(r.imported?.count, 1, JSON.stringify(r));
  await b.settings({ login: 'never' });
  assert.match((await analyze('from_txt')).error, /403/);
  await b.settings({ login: 'always' });
  const ok = await analyze('from_txt');
  assert.ok(!ok.error, ok.error);
  assert.match(seen.at(-1).cookie, /from_txt=yes/);
});

test('Firefox cookies, including the newest ones still in the -wal file', async () => {
  const r = await importCookies('firefox', ['firefox/cookies.sqlite', 'firefox/cookies.sqlite-wal']);
  assert.equal(r.imported?.count, 2, JSON.stringify(r));
  await b.settings({ login: 'always' });
  assert.ok(!(await analyze('from_firefox_wal')).error);
  // Without the -wal file only the older cookie is there.
  assert.equal((await importCookies('firefox', ['firefox/cookies.sqlite'])).imported?.count, 1);
});

test('Chromium cookies without a keyring are decrypted', async () => {
  const r = await importCookies('chromium', ['chromium/Cookies']);
  assert.equal(r.imported?.count, 2, JSON.stringify(r));
  await b.settings({ login: 'always' });
  assert.ok(!(await analyze('from_chromium')).error);
  assert.ok(!(await analyze('from_chromium_plain')).error);
});

test('a file that is not a cookie store gives a clear error, and import can be removed', async () => {
  const bad = await b.send({ cmd: 'importCookies', kind: 'firefox', files: [{ name: 'cookies.sqlite', data: Buffer.from('not a database').toString('base64') }] });
  assert.ok(bad.error);
  await b.send({ cmd: 'removeCookies' });
  assert.equal((await b.send({ cmd: 'importedCookies' })).imported, null);
});

test('the options show where each browser keeps its cookies', async () => {
  const page = await b.context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${b.extId}/popup.html`);
  await page.click('#gear');
  await page.selectOption('#impSystem', 'linux');
  await page.selectOption('#impBrowser', 'firefox');
  const paths = await page.locator('#impPaths li').allTextContents();
  assert.ok(paths.some((p) => p.includes('~/.mozilla/firefox/')), paths.join('\n'));
  await page.selectOption('#impSystem', 'windows');
  await page.selectOption('#impBrowser', 'chrome');
  const notes = (await page.locator('#impNotes li').allTextContents()).join(' ');
  assert.match(notes, /cookies\.txt/);
  assert.deepEqual(errors, []);
  await page.close();
});
