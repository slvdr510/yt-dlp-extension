import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseTracks, parseVtt, parseJson3, pickFormat } from '../../extension/engine/subs.js';

test('picks the creator subtitles and only the original automatic captions', () => {
  const fmt = (ext) => [{ ext: 'srv3', url: 'x' }, { ext, url: `u-${ext}`, name: 'N' }];
  const info = {
    language: 'en',
    subtitles: { en: fmt('vtt'), 'es-419': fmt('json3'), live_chat: fmt('json') },
    automatic_captions: { en: fmt('json3'), 'en-orig': fmt('json3'), fr: fmt('json3'), de: fmt('json3') },
  };
  const t = chooseTracks(info);
  assert.deepEqual(t.map((x) => [x.lang, x.auto, x.format.ext]), [['en', false, 'vtt'], ['es-419', false, 'json3']]);
  // An original-language automatic track is only added when the creator didn't upload that language.
  const t2 = chooseTracks({ ...info, subtitles: {} });
  assert.deepEqual(t2.map((x) => [x.lang, x.auto]), [['en', true]]);
  assert.equal(t2[0].name, 'N (auto)');
  assert.equal(pickFormat([{ ext: 'ttml', url: 'x' }]), null);
});

test('WebVTT: tags, entities, and YouTube scrolling repeats', () => {
  const vtt = `WEBVTT
Kind: captions

00:00:01.000 --> 00:00:03.000 align:start position:0%
hello<00:00:01.500><c> there</c>

00:00:03.000 --> 00:00:03.010
hello there

00:00:03.010 --> 00:00:05.000
hello there
general &amp; kenobi

1
00:01:02,500 --> 00:01:04,000
<i>srt style</i>`;
  assert.deepEqual(parseVtt(vtt), [
    { start: 1, end: 3, text: 'hello there' },
    { start: 3.01, end: 5, text: 'general & kenobi' },
    { start: 62.5, end: 64, text: 'srt style' },
  ]);
});

test('json3: segments joined, overlaps trimmed', () => {
  const j = JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'Hi' }, { utf8: ' you' }] },
    { tStartMs: 1000, dDurationMs: 50, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 2000, dDurationMs: 2000, segs: [{ utf8: 'next' }] },
    { tStartMs: 5000 },
  ] });
  assert.deepEqual(parseJson3(j), [{ start: 0, end: 2, text: 'Hi you' }, { start: 2, end: 4, text: 'next' }]);
});
