import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readTracks } from '../../extension/engine/mp4out.js';
import { aacConfig, id3, wavHeader } from '../../extension/engine/audio.js';
import { fixtureBlob, fixtureBytes, saveBlob, tempFile } from './env.mjs';
import { probe } from '../e2e/harness.mjs';

const meta = { title: 'Canción ñ', artist: 'Artista', album: 'Álbum', date: '2024-05-01' };

test('reads the AAC decoder setup from an MP4 track', async () => {
  const track = (await readTracks(fixtureBlob('clip.mp4'))).find((t) => t.kind === 'soun');
  const c = aacConfig(track.stsd);
  assert.equal(c.codec, 'mp4a.40.2');
  assert.equal(c.sampleRate, 48000);
  assert.equal(c.numberOfChannels, 1);
  assert.ok(c.description.length >= 2);
});

test('ID3 tag: song details and cover that players read', async () => {
  const plain = tempFile('plain.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-id3v2_version', '0', '-write_xing', '0', plain]);
  const tag = id3({ ...meta, cover: { bytes: fixtureBytes('cover.jpg'), type: 'jpeg' } });
  const file = await saveBlob(new Blob([tag, readFileSync(plain)]), 'tagged.mp3');
  const p = probe(file);
  assert.equal(p.tags.title, meta.title);
  assert.equal(p.tags.artist, meta.artist);
  assert.equal(p.tags.album, meta.album);
  assert.equal(p.tags.date, '2024');
  assert.ok(p.streams.some((s) => s.disposition?.attached_pic), 'cover');
  assert.ok(Math.abs(p.duration - 1) < 0.1, `duration ${p.duration}`);
});

test('WAV header: 16-bit PCM with the song details', async () => {
  const frames = 48000;
  const pcm = new Int16Array(frames * 2).map((_, i) => Math.round(Math.sin(i / 20) * 8000));
  const header = wavHeader({ sampleRate: 48000, channels: 2, dataSize: pcm.byteLength, meta });
  const file = await saveBlob(new Blob([header, pcm]), 'a.wav');
  const p = probe(file);
  assert.equal(p.streams[0].codec, 'pcm_s16le');
  assert.equal(p.tags.title, meta.title);
  assert.equal(p.tags.artist, meta.artist);
  assert.ok(Math.abs(p.duration - 1) < 0.01, `duration ${p.duration}`);
  assert.equal(execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']).toString(), '');
});
