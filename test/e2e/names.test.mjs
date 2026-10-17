import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, launch } from './harness.mjs';

// Another extension listening to onDeterminingFilename makes Chrome drop the name
// given to chrome.downloads.download (the file gets the blob's UUID).
const NAMER = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/namer-extension');

let server, b;
before(async () => {
  server = await startServer();
  b = await launch({ others: [NAMER] });
  await b.settings({ sleepMin: 0, sleepRandom: 0 });
});
after(async () => {
  await b?.close();
  await server?.close();
});

const saved = async (msg) => {
  const { id } = await b.send(msg);
  const job = await b.job(id, ['done', 'failed', 'cancelled'], 90000);
  assert.equal(job.state, 'done', job.error);
  const jobs = msg.playlist ? Object.values(await b.session('jobs')).filter((j) => j.parent === id) : [job];
  return (await Promise.all(jobs.map((j) => b.files(j)))).flat().sort();
};

test('a file keeps its name next to a download manager', async () => {
  const [file] = await saved({ cmd: 'download', url: `${server.base}/clip.mp4`, mode: 'music', overrides: { audioFormat: 'mp3' } });
  assert.match(file, /\/clip\.mp3$/);
});

test('playlist files keep their names next to a download manager (without the folder)', async () => {
  const files = await saved({ cmd: 'download', url: `${server.base}/feed.xml`, mode: 'video', playlist: true });
  assert.deepEqual(files.map((f) => f.split('/').pop()), ['First_clip.mp4', 'Second_clip.mp4']);
  // The file Chrome named after the blob is gone.
  assert.ok(!readdirSync(b.downloads).some((n) => /^[0-9a-f]{8}-/.test(n)), readdirSync(b.downloads).join());
});
