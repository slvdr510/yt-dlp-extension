import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startServer, launch, probe, decodeErrors } from './harness.mjs';

let server, b;
before(async () => {
  server = await startServer();
  b = await launch();
});
after(async () => {
  await b?.close();
  await server?.close();
});

const near = (a, x, tol = 0.2) => Math.abs(a - x) < tol;
async function download(path, opts = {}) {
  const { id } = await b.send({ cmd: 'download', url: `${server.base}/${path}`, ...opts });
  const job = await b.job(id);
  return { job, files: job.state === 'done' ? await b.files(job) : [] };
}

test('a video downloads as one MP4', async () => {
  const { job, files } = await download('clip.mp4', { mode: 'video' });
  assert.equal(job.state, 'done', job.error);
  assert.match(files[0], /clip\.mp4$/);
  const p = probe(files[0]);
  assert.deepEqual(p.streams.filter((s) => !s.disposition?.attached_pic).map((s) => s.type).sort(), ['audio', 'video']);
  assert.ok(near(p.duration, 8));
  assert.equal(decodeErrors(files[0]), '');
});

test('subtitles from the page are embedded', async () => {
  const { job, files } = await download('subs.html', { mode: 'video' });
  assert.equal(job.state, 'done', job.error);
  const p = probe(files[0]);
  assert.deepEqual(p.streams.filter((s) => s.type === 'subtitle').map((s) => [s.codec, s.lang]), [['mov_text', 'eng']]);
  const srt = execFileSync('ffmpeg', ['-v', 'error', '-i', files[0], '-map', '0:s:0', '-f', 'srt', '-']).toString();
  assert.match(srt, /00:00:01,000 --> 00:00:03,000\r?\nHello from the track/);
});

test('music mode saves the sound only, as M4A', async () => {
  const { job, files } = await download('clip.mp4', { mode: 'music' });
  assert.equal(job.state, 'done', job.error);
  assert.match(files[0], /\.m4a$/);
  const p = probe(files[0]);
  assert.deepEqual(p.streams.filter((s) => !s.disposition?.attached_pic).map((s) => s.type), ['audio']);
  assert.ok(near(p.duration, 8));
});

for (const [format, codec] of [['mp3', 'mp3'], ['wav', 'pcm_s16le']]) {
  test(`music can be converted to ${format.toUpperCase()}`, async () => {
    const { job, files } = await download('clip.mp4', { mode: 'music', overrides: { audioFormat: format } });
    assert.equal(job.state, 'done', job.error);
    assert.match(files[0], new RegExp(`clip\\.${format}$`));
    const p = probe(files[0]);
    assert.deepEqual(p.streams.filter((s) => !s.disposition?.attached_pic).map((s) => s.codec), [codec]);
    assert.ok(near(p.duration, 8, 0.15), `duration ${p.duration}`);
    assert.equal(p.tags.title, 'clip');
    assert.equal(decodeErrors(files[0]), '');
  });
}

test('HLS streams are downloaded and converted', async () => {
  const { job, files } = await download('hls/index.m3u8', { mode: 'video' });
  assert.equal(job.state, 'done', job.error);
  const p = probe(files[0]);
  assert.ok(near(p.duration, 8, 0.3), `duration ${p.duration}`);
  assert.equal(decodeErrors(files[0]), '');
});

test('a playlist downloads every video with a pause between them', async () => {
  await b.settings({ sleepMin: 1, sleepRandom: 1 });
  const t0 = Date.now();
  const { id } = await b.send({ cmd: 'download', url: `${server.base}/feed.xml`, mode: 'video', playlist: true });
  const parent = await b.job(id, ['done', 'failed', 'cancelled'], 90000);
  assert.equal(parent.state, 'done', JSON.stringify(parent));
  const jobs = Object.values(await b.session('jobs')).filter((j) => j.parent === id).sort((a, x) => a.playlist.index - x.playlist.index);
  assert.deepEqual(jobs.map((j) => j.state), ['done', 'done']);
  const files = (await Promise.all(jobs.map((j) => b.files(j)))).flat();
  assert.match(files[0], /Test feed\/1 - First clip\.mp4$/);
  assert.match(files[1], /Test feed\/2 - Second clip\.mp4$/);
  assert.ok(Date.now() - t0 >= 1000, 'paused between videos');
});

test('cancel stops a queued playlist', async () => {
  await b.settings({ sleepMin: 30, sleepRandom: 0 });
  const { id } = await b.send({ cmd: 'download', url: `${server.base}/feed.xml`, mode: 'video', playlist: true });
  // Wait until the second video is pausing, then cancel the playlist.
  for (let i = 0; i < 200; i++) {
    const kids = Object.values((await b.session('jobs')) || {}).filter((j) => j.parent === id);
    if (kids.some((k) => k.state === 'waiting')) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await b.send({ cmd: 'cancel', id });
  const parent = await b.job(id, ['done', 'failed', 'cancelled'], 10000);
  const kids = Object.values(await b.session('jobs')).filter((j) => j.parent === id);
  assert.ok(kids.some((k) => k.state === 'cancelled'), JSON.stringify(kids.map((k) => k.state)));
  assert.ok(['done', 'cancelled'].includes(parent.state));
  await b.settings({ sleepMin: 10, sleepRandom: 10 });
});

test('cancel stops a download while yt-dlp is still reading the page', async () => {
  server.hooks.push((req, res, url) => {
    if (url.pathname !== '/slow.html') return false;
    setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end('<video src="clip.mp4"></video>'), 10000);
    return true;
  });
  const { id } = await b.send({ cmd: 'download', url: `${server.base}/slow.html`, mode: 'video' });
  await b.job(id, ['extracting']);
  const t0 = Date.now();
  await b.send({ cmd: 'cancel', id });
  const job = await b.job(id, ['done', 'failed', 'cancelled'], 8000);
  assert.equal(job.state, 'cancelled');
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test('the popup opens without errors', async () => {
  const page = await b.context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`chrome-extension://${b.extId}/popup.html`);
  await page.waitForTimeout(800);
  assert.deepEqual(errors, []);
  await page.close();
});

const online = { skip: !process.env.ONLINE && 'set ONLINE=1 to run' };

test('YouTube video: best quality, subtitles, chapters-ready MP4 (online)', online, async () => {
  const { id } = await b.send({ cmd: 'download', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', mode: 'auto' });
  const job = await b.job(id, ['done', 'failed', 'cancelled'], 180000);
  assert.equal(job.state, 'done', job.error);
  const [file] = await b.files(job);
  const p = probe(file);
  const types = p.streams.map((s) => (s.disposition?.attached_pic ? 'cover' : s.type));
  assert.ok(types.includes('video') && types.includes('audio') && types.includes('cover'), types.join());
  assert.deepEqual(p.streams.filter((s) => s.type === 'subtitle').map((s) => s.lang).sort(), ['deu', 'eng']);
  assert.equal(p.tags.title, 'Me at the zoo');
  assert.ok(near(p.duration, 19, 1.5), `duration ${p.duration}`);
  assert.equal(decodeErrors(file), '');
});

test('YouTube music: sound only, cover, song details (online)', online, async () => {
  const { id } = await b.send({ cmd: 'download', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', mode: 'auto' });
  const job = await b.job(id, ['done', 'failed', 'cancelled'], 180000);
  assert.equal(job.state, 'done', job.error);
  assert.equal(job.music, true);
  const [file] = await b.files(job);
  assert.match(file, /\.m4a$/);
  const p = probe(file);
  const cover = p.streams.find((s) => s.disposition?.attached_pic);
  // An official video's thumbnail is a picture, not album art in bars: kept whole.
  assert.ok(cover && cover.width > cover.height, `cover ${cover?.width}x${cover?.height}`);
  assert.ok(p.tags.artist, 'artist');
  assert.ok(near(p.duration, 213, 3), `duration ${p.duration}`);
  assert.equal(decodeErrors(file), '');
});
