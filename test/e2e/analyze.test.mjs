import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launch } from './harness.mjs';

let server, b;
before(async () => {
  server = await startServer();
  b = await launch();
});
after(async () => {
  await b?.close();
  await server?.close();
});

test('yt-dlp loads inside the extension', async () => {
  const v = await b.send({ cmd: 'versions' });
  assert.equal(v['yt-dlp'], '2026.08.19', JSON.stringify(v));
});

test('a direct video link is analyzed by yt-dlp', async () => {
  const r = await b.send({ cmd: 'analyze', url: `${server.base}/clip.mp4` });
  assert.ok(!r.error, r.error);
  assert.equal(r.summary.kind, 'video');
  assert.equal(r.summary.music, false);
  assert.equal(r.summary.extractor, 'Generic');
});

test('a page with a <video> is analyzed', async () => {
  const r = await b.send({ cmd: 'analyze', url: `${server.base}/page.html` });
  assert.ok(!r.error, r.error);
  assert.match(r.summary.title, /Test clip/);
});

test('errors come back readable', async () => {
  const r = await b.send({ cmd: 'analyze', url: `${server.base}/missing.html` });
  assert.match(r.error, /404/);
});

test('YouTube (online)', { skip: !process.env.ONLINE && 'set ONLINE=1 to run' }, async () => {
  const r = await b.send({ cmd: 'analyze', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.ok(!r.error, r.error);
  assert.equal(r.summary.music, true);
  assert.ok(r.summary.heights[0] >= 1080);
  assert.ok(r.summary.subtitles.options.some((o) => o.id === 'c:en'));
  assert.equal(r.summary.subtitles.default, 'c:en');
});
