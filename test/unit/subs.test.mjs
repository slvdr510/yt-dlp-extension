import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseTracks, subtitleOptions, parseVtt, parseJson3, pickFormat } from '../../extension/engine/subs.js';
import { plainSides } from '../../extension/engine/thumb.js';

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

test('dubbed videos: the automatic captions in the video\'s own language come first', () => {
  const fmt = (name) => [{ ext: 'json3', url: 'u', name }];
  const info = {
    language: 'es-US',
    subtitles: {},
    automatic_captions: { 'ar-orig': fmt('Arabic (Original)'), ar: fmt('Arabic'), es: fmt('Spanish'), 'es-orig': fmt('Spanish (Original)'), 'en-orig': fmt('English (Original)'), fr: fmt('French'), de: fmt('German') },
  };
  assert.deepEqual(chooseTracks(info).map((t) => [t.lang, t.name]), [['es', 'Spanish (auto)']]);
  assert.deepEqual(subtitleOptions(info).map((o) => [o.id, o.group]), [
    ['a:es-orig', 'auto'], ['a:ar-orig', 'auto'], ['a:en-orig', 'auto'], ['a:fr', 'translated'], ['a:de', 'translated'],
  ]);
  assert.deepEqual(chooseTracks(info, 'a:fr').map((t) => [t.lang, t.auto]), [['fr', true]]);
  assert.deepEqual(chooseTracks(info, ['a:es-orig', 'a:fr', 'c:it']).map((t) => [t.lang, t.auto]), [['es', true], ['fr', true]]);
  // A pick the video doesn't have falls back to the default choice.
  assert.deepEqual(chooseTracks(info, 'c:it').map((t) => t.lang), ['es']);
});

test('the creator\'s subtitles come first in the menu', () => {
  const fmt = (name) => [{ ext: 'vtt', url: 'u', name }];
  const info = { language: 'en', subtitles: { de: fmt('German'), 'en-GB': fmt('English') }, automatic_captions: { 'en-orig': fmt('English (Original)') } };
  assert.deepEqual(subtitleOptions(info).map((o) => o.id), ['c:de', 'c:en-GB', 'a:en-orig']);
});

test('covers: album art in plain side bars is cropped, pictures are kept whole', () => {
  const image = (sides) => {
    const width = 64, height = 36, data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, inner = x >= 14 && x < 50;
      data.fill(inner || !sides ? (x * 37 + y * 91) % 256 : 20, i, i + 3);
    }
    return { data, width, height };
  };
  assert.equal(plainSides(image(true)), true);
  assert.equal(plainSides(image(false)), false);
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
