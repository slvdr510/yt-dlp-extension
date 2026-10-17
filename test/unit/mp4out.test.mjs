import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTracks, writeMp4, textSamples, lang3 } from '../../extension/engine/mp4out.js';
import { fixtureBlob, fixtureBytes, saveBlob } from './env.mjs';
import { probe, decodeErrors } from '../e2e/harness.mjs';

const near = (a, b, tol = 0.15) => Math.abs(a - b) < tol;
const types = (p) => p.streams.map((s) => s.type).sort();
const withBlob = async (name) => (await readTracks(fixtureBlob(name))).map((t) => ({ ...t, blob: fixtureBlob(name) }));

test('reads the samples of a normal MP4 with B-frames', async () => {
  const tracks = await readTracks(fixtureBlob('bframes.mp4'));
  const v = tracks.find((t) => t.kind === 'vide');
  assert.equal(v.samples.length, 192);
  assert.ok(v.samples.some((s) => s.cto > 0), 'composition offsets');
  assert.ok(v.samples.filter((s) => s.sync).length >= 4);
  assert.equal(v.width, 320);
});

test('reads the samples of fragmented tracks', async () => {
  const [v] = await readTracks(fixtureBlob('dash-video.mp4'));
  const [a] = await readTracks(fixtureBlob('dash-audio.m4a'));
  assert.equal(v.kind, 'vide');
  assert.equal(v.samples.length, 192);
  assert.equal(a.kind, 'soun');
  assert.ok(near(a.samples.reduce((n, s) => n + s.duration, 0) / a.timescale, 8, 0.1));
});

test('rewrites a normal MP4 losslessly', async () => {
  const file = await saveBlob(writeMp4({ tracks: await withBlob('bframes.mp4') }), 'copy.mp4');
  const p = probe(file);
  assert.deepEqual(types(p), ['audio', 'video']);
  assert.ok(near(p.duration, 8), `duration ${p.duration}`);
  assert.equal(decodeErrors(file), '');
});

test('joins fragmented video and audio into one standard MP4', async () => {
  const file = await saveBlob(writeMp4({ tracks: [...(await withBlob('dash-video.mp4')), ...(await withBlob('dash-audio.m4a'))] }), 'joined.mp4');
  const p = probe(file);
  assert.deepEqual(types(p), ['audio', 'video']);
  assert.ok(near(p.duration, 8), `duration ${p.duration}`);
  assert.equal(decodeErrors(file), '');
});

test('subtitles, chapters, metadata and cover are embedded', async () => {
  const cues = [
    { start: 0.5, end: 2, text: 'Hello' },
    { start: 3, end: 5, text: 'World' },
  ];
  const blob = writeMp4({
    tracks: [
      ...(await withBlob('dash-video.mp4')),
      ...(await withBlob('dash-audio.m4a')),
      { kind: 'sbtl', cues, language: 'en', title: 'English', default: true },
      { kind: 'sbtl', cues: [{ start: 1, end: 2, text: 'Hola' }], language: 'es-419', title: 'Spanish' },
    ],
    meta: { title: 'My video', artist: 'Someone', date: '2024', genre: 'Gaming', comment: 'https://example.com/v', description: 'All of it', cover: { bytes: fixtureBytes('cover.jpg'), type: 'jpeg' } },
    chapters: [{ start: 0, title: 'Intro' }, { start: 4, title: 'Part two' }],
  });
  const file = await saveBlob(blob, 'full.mp4');
  const p = probe(file);
  const subs = p.streams.filter((s) => s.type === 'subtitle');
  assert.deepEqual(subs.map((s) => [s.codec, s.lang]), [['mov_text', 'eng'], ['mov_text', 'spa']]);
  assert.equal(subs[0].disposition.default, 1);
  assert.equal(subs[1].disposition.default, 0);
  assert.deepEqual(p.chapters.map((c) => [Math.round(Number(c.start_time)), c.tags?.title]), [[0, 'Intro'], [4, 'Part two']]);
  assert.equal(p.tags.title, 'My video');
  assert.equal(p.tags.artist, 'Someone');
  assert.equal(p.tags.genre, 'Gaming');
  assert.equal(p.tags.comment, 'https://example.com/v');
  assert.equal(p.tags.description, 'All of it');
  assert.equal(p.tags.synopsis, 'All of it');
  assert.ok(p.streams.some((s) => s.disposition?.attached_pic === 1), 'cover art');
  assert.equal(decodeErrors(file), '');
});

test('audio-only M4A with cover art', async () => {
  const file = await saveBlob(writeMp4({ tracks: await withBlob('dash-audio.m4a'), audioOnly: true, meta: { title: 'Song', artist: 'Band', album: 'Album', cover: { bytes: fixtureBytes('cover.jpg'), type: 'jpeg' } } }), 'song.m4a');
  const p = probe(file);
  assert.equal(p.tags.album, 'Album');
  assert.equal(p.tags.major_brand, 'M4A ');
  assert.ok(near(p.duration, 8));
  assert.ok(p.streams.some((s) => s.disposition?.attached_pic === 1));
  assert.equal(decodeErrors(file), '');
});

test('64-bit chunk offsets', async () => {
  const file = await saveBlob(writeMp4({ tracks: await withBlob('bframes.mp4'), forceLarge: true }), 'large.mp4');
  assert.ok(near(probe(file).duration, 8));
  assert.equal(decodeErrors(file), '');
});

test('subtitle samples fill gaps and cut overlaps', () => {
  const s = textSamples([{ start: 1, end: 3, text: 'a' }, { start: 2, end: 4, text: 'b' }]);
  assert.deepEqual(s.map((x) => x.duration), [1000, 1000, 2000]);
  assert.deepEqual(s.map((x) => x.size), [2, 3, 3]);
  assert.equal(lang3('pt-BR'), 'por');
  assert.equal(lang3('xx'), 'und');
});

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { OUT } from './env.mjs';

const pts = (file, stream) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time,dts_time', '-of', 'csv=p=0', file]).toString().trim();

test('timestamps survive exactly (B-frames, edit lists)', async () => {
  const file = await saveBlob(writeMp4({ tracks: await withBlob('bframes.mp4') }), 'exact.mp4');
  for (const s of ['v:0', 'a:0']) assert.equal(pts(file, s), pts(join(OUT, 'bframes.mp4'), s), `stream ${s}`);
});

test('subtitle text and timing come back out', async () => {
  const file = await saveBlob(writeMp4({
    tracks: [...(await withBlob('dash-video.mp4')), { kind: 'sbtl', cues: [{ start: 0.5, end: 2, text: 'Hello, ñandú' }, { start: 3, end: 5.25, text: 'Line one\nLine two' }], language: 'es', default: true }],
  }), 'subs.mp4');
  const srt = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:s:0', '-f', 'srt', '-']).toString();
  assert.match(srt, /00:00:00,500 --> 00:00:02,000\r?\nHello, ñandú/);
  assert.match(srt, /00:00:03,000 --> 00:00:05,250\r?\nLine one\r?\nLine two/);
});

test('long tracks: sample tables bigger than a call takes arguments', async () => {
  // About 40 minutes at 60 fps, from the B-frames video's samples over and over.
  const [v] = (await withBlob('bframes.mp4')).filter((t) => t.kind === 'vide');
  const samples = Array.from({ length: 150_000 }, (_, i) => v.samples[i % v.samples.length]);
  const blob = writeMp4({ tracks: [{ ...v, samples }] });
  const [back] = await readTracks(blob);
  assert.equal(back.samples.length, 150_000);
  assert.deepEqual(back.samples.slice(0, 192).map((s) => s.size), v.samples.map((s) => s.size));
});
