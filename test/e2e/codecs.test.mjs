import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

// HLS formats with TS segments are converted by lib/ts.js (mux.js only did H.264 + AAC).
for (const [dir, codecs] of [['hls-hevc-ac3', ['ac3', 'hevc']], ['hls-h264-eac3', ['eac3', 'h264']]]) {
  test(`an HLS stream with ${codecs.join(' + ')} downloads as one MP4`, async () => {
    const { id } = await b.send({ cmd: 'download', url: `${server.base}/${dir}/index.m3u8`, mode: 'video' });
    const job = await b.job(id);
    assert.equal(job.state, 'done', job.error);
    const [file] = await b.files(job);
    assert.match(file, /\.mp4$/);
    const p = probe(file);
    const media = p.streams.filter((s) => !s.disposition?.attached_pic);
    assert.deepEqual(media.map((s) => s.codec).sort(), codecs);
    assert.ok(Math.abs(p.duration - 8) < 0.3, `duration ${p.duration}`);
    assert.equal(decodeErrors(file), '');
  });
}
