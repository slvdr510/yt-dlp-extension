// Test media made with ffmpeg into test/fixtures/out (skipped when already there).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const VERSION = '1';
const ff = (args, cwd = OUT) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd });
const SRC = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8'];
const ENC = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-b:v', '1M', '-c:a', 'aac', '-b:a', '96k'];

export function makeFixtures() {
  const stamp = join(OUT, '.version');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === VERSION) return OUT;
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  ff([...SRC, ...ENC, '-movflags', '+faststart', 'clip.mp4']);
  writeFileSync(join(OUT, 'page.html'), '<!doctype html><title>Test clip S01E02</title><video src="clip.mp4" controls></video>');
  writeFileSync(stamp, VERSION);
  return OUT;
}
