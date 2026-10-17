import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileName } from '../../extension/engine/names.js';

const fields = { title: 'Me at the zoo', channel: 'jawed', artist: 'jawed', track: 'Zoo', date: '2005-04-23', id: 'jNQXAC9IVRw' };

test('file names from a template', () => {
  assert.equal(fileName('{title}', fields), 'Me at the zoo');
  assert.equal(fileName('{artist} - {track} [{id}]', fields), 'jawed - Zoo [jNQXAC9IVRw]');
  assert.equal(fileName('{date} {title}', fields, { underscores: true, number: '07' }), '07_-_2005-04-23_Me_at_the_zoo');
  // Unknown fields stay as written; an empty template is the title.
  assert.equal(fileName('{nope} {title}', fields), '{nope} Me at the zoo');
  assert.equal(fileName('  ', fields), 'Me at the zoo');
});

test('empty fields take their separators with them', () => {
  const some = { ...fields, date: '', artist: '' };
  assert.equal(fileName('{date} - {title}', some), 'Me at the zoo');
  assert.equal(fileName('{channel} - {date} - {title}', some), 'jawed - Me at the zoo');
  assert.equal(fileName('{artist}', some), 'Me at the zoo');
});

test('names are safe on every system', () => {
  assert.equal(fileName('{title}', { ...fields, title: 'a/b: c?' }), 'a b c');
});
