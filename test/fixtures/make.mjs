// Test media made with ffmpeg into test/fixtures/out (skipped when already there).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const VERSION = '3';
const ff = (args, cwd = OUT) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd });
const SRC = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8'];
const ENC = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-b:v', '1M', '-c:a', 'aac', '-b:a', '96k'];

export function makeFixtures() {
  const stamp = join(OUT, '.version');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === VERSION) return OUT;
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  ff([...SRC, ...ENC, '-movflags', '+faststart', 'clip.mp4']);
  // Like YouTube's DASH formats: video and audio apart, fragmented, with a sidx.
  ff([...SRC, '-map', '0:v', '-an', ...ENC, '-movflags', '+dash+global_sidx', '-frag_duration', '2000000', '-f', 'mp4', 'dash-video.mp4']);
  ff([...SRC, '-map', '1:a', '-vn', ...ENC, '-movflags', '+dash+global_sidx', '-frag_duration', '2000000', '-f', 'mp4', 'dash-audio.m4a']);
  // A normal MP4 with B-frames (composition offsets, edit lists).
  ff([...SRC, '-c:v', 'libx264', '-preset', 'medium', '-bf', '2', '-g', '48', '-b:v', '600k', '-c:a', 'aac', '-b:a', '96k', 'bframes.mp4']);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=480x360:duration=1', '-frames:v', '1', 'cover.jpg']);
  // HLS (TS segments, audio and video together).
  mkdirSync(join(OUT, 'hls'), { recursive: true });
  ff([...SRC, ...ENC, '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', 's_%03d.ts', 'index.m3u8'], join(OUT, 'hls'));
  // A second clip, and subtitles for the <track> page.
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4', ...ENC, 'clip2.mp4']);
  writeFileSync(join(OUT, 'en.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello from the track\n\n00:00:04.000 --> 00:00:06.000\nSecond line\n');
  writeFileSync(join(OUT, 'subs.html'), '<!doctype html><title>Clip with subtitles</title><video src="clip.mp4" controls><track kind="subtitles" srclang="en" label="English" src="en.vtt"></video>');
  // An RSS feed: yt-dlp lists its items as a playlist.
  writeFileSync(join(OUT, 'feed.xml'), `<?xml version="1.0"?><rss version="2.0"><channel><title>Test feed</title><link>http://x/</link><description>d</description>
<item><title>First clip</title><enclosure url="clip.mp4" type="video/mp4" length="1"/><link>clip.mp4</link></item>
<item><title>Second clip</title><enclosure url="clip2.mp4" type="video/mp4" length="1"/><link>clip2.mp4</link></item>
</channel></rss>`);
  writeFileSync(join(OUT, 'page.html'), '<!doctype html><title>Test clip S01E02</title><video src="clip.mp4" controls></video>');
  writeFileSync(stamp, VERSION);
  return OUT;
}
