// Helpers for unit tests run in Node.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixtures } from '../fixtures/make.mjs';

export const OUT = makeFixtures();
export const fixtureBlob = (name) => new Blob([readFileSync(join(OUT, name))]);
export const fixtureBytes = (name) => new Uint8Array(readFileSync(join(OUT, name)));

// A path for a test's output, in one temporary folder deleted when the tests end.
let temp = null;
export function tempFile(name) {
  if (!temp) {
    temp = mkdtempSync(join(tmpdir(), 'ytx-test-'));
    process.on('exit', () => rmSync(temp, { recursive: true, force: true }));
  }
  return join(temp, `${crypto.randomUUID()}-${name}`);
}

export async function saveBlob(blob, name) {
  const file = tempFile(name);
  writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  return file;
}
