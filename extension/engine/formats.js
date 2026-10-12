// yt-dlp format specs for each mode. Only formats the extension can download
// (and join into MP4 or M4A) are picked; the rest are left to the fallbacks.
import { PROTOCOLS } from './download.js';

const OK = `[protocol~='^(${PROTOCOLS.join('|')})$']`;

// mode: 'video' | 'music'. maxHeight: 0 for the best, else a cap (1080, 720…).
// compatible: prefer H.264 video, which plays everywhere (best is often AV1/VP9).
export function formatSpec({ mode, maxHeight = 0, compatible = false }) {
  if (mode === 'music') return [`ba[ext=m4a]${OK}`, `ba[acodec^=mp4a]${OK}`, `ba${OK}`, `b${OK}`].join('/');
  const h = maxHeight ? `[height<=${maxHeight}]` : '';
  const codec = compatible ? '[vcodec^=avc1]' : '';
  return [
    `bv*[ext=mp4]${codec}${h}${OK}+ba[ext=m4a]${OK}`,
    `bv*[ext=mp4]${h}${OK}+ba[ext=m4a]${OK}`,
    `b[ext=mp4]${h}${OK}`,
    `bv*${h}${OK}+ba${OK}`,
    `b${h}${OK}`,
    `b${OK}`,
  ].join('/');
}
