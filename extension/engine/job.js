// One video's download, start to finish: extract with yt-dlp, download the
// chosen formats, add subtitles, chapters, metadata and cover, write one file.
import { extract, useCookies } from './ytdlp.js';
import { formatSpec } from './formats.js';
import { downloadFormat, PROTOCOLS } from './download.js';
import { readTracks, writeMp4 } from './mp4out.js';
import { chooseTracks, parseSubtitles } from './subs.js';
import { coverFrom } from './thumb.js';
import { isMusic } from './summary.js';
import { fileName } from './names.js';
import { indexBlob } from '../lib/fmp4.js';
import { convertAudio } from './audio.js';

// Errors that mean the site wants the user to be logged in.
const NEEDS_LOGIN = /\b401\b|unauthori[sz]ed|sign in|age[- ]restrict|inappropriate|members|private video|confirm (you|your)|log ?in|login required/i;

const sleep = (seconds, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, seconds * 1000);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

// Extracts without a login first, and again with one if the site asks for it. The
// login is the imported cookies (settings.cookies) if any, else this browser's.
export async function extractWithLogin(url, options, settings) {
  const { cookies } = settings;
  const loggedIn = () => {
    useCookies(!cookies);
    return extract(url, cookies ? { ...options, cookies } : options);
  };
  useCookies(false);
  try {
    return await extract(url, options);
  } catch (e) {
    if (options.signal?.aborted || !NEEDS_LOGIN.test(e.message)) throw e;
    return loggedIn();
  }
}

// The video spec used for analysis and downloads, so one extraction serves both.
export const videoSpec = (settings) => formatSpec({ mode: 'video', maxHeight: settings.maxHeight, compatible: settings.compatible });

// The best audio-only format we can download, M4A/AAC first (Opus first with
// `opus`). Null if there's none.
const isOpus = (f) => /^opus/.test(f.acodec || '');
function bestAudio(formats = [], opus = false) {
  const ok = formats.filter((f) => f.vcodec === 'none' && f.acodec !== 'none' && f.url && PROTOCOLS.includes(f.protocol || 'https'));
  const rank = (f) => [opus && isOpus(f) ? 3 : f.ext === 'm4a' ? 2 : /^mp4a/.test(f.acodec || '') ? 1 : 0, f.abr || f.tbr || 0];
  ok.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return y[0] - x[0] || y[1] - x[1];
  });
  return ok[0] || null;
}

const artistOf = (info) => info.artist || info.artists?.join(', ') || info.creator || (info.channel || info.uploader || '').replace(/ - Topic$/, '');
const dateOf = (info) => {
  const d = info.release_date || info.upload_date || '';
  return d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : info.release_year ? String(info.release_year) : '';
};

// Runs one video. `job`: { url, mode: 'auto'|'video'|'music' }. Helpers:
// report(patch) updates the job; rules(hosts, headers) sets request headers.
// Resolves to { files: [{ blob, ext, name, cleanup }], notes, title }.
export async function runVideo(job, { settings, signal, report, rules }) {
  report({ state: 'extracting' });
  const info = await extractWithLogin(job.url, { format: videoSpec(settings), signal }, settings);
  if (info._type === 'playlist') throw new Error('This is a playlist: download it as one.');
  if (info.is_live) throw new Error('Live streams aren’t supported yet: try again when it has ended.');
  const music = job.mode === 'music' || (job.mode !== 'video' && isMusic(info));
  report({ title: info.title, music });

  // What to download. Music: settings.audioFormat says how it's saved.
  const audioFormat = settings.audioFormat || 'm4a';
  const requested = info.requested_formats || [info];
  let formats = requested;
  if (music) {
    const audio = bestAudio(info.formats, audioFormat === 'opus');
    formats = audio ? [audio] : [requested[requested.length - 1]];
  }

  // Download each format, with one progress across all of them.
  const totals = formats.map((f) => f.filesize || f.filesize_approx || 0);
  const done = formats.map(() => 0);
  const files = [];
  try {
    for (let i = 0; i < formats.length; i++) {
      report({ state: 'downloading', progress: { part: i + 1, parts: formats.length, bytes: 0, total: totals.reduce((a, b) => a + b, 0) } });
      const file = await downloadFormat(formats[i], {
        signal,
        rules,
        onProgress: ({ bytes, done: d, total: t }) => {
          done[i] = bytes;
          // Segment downloads report segments: estimate the bytes still to come.
          if (!totals[i] && t > d) totals[i] = Math.round((bytes / d) * t);
          report({ progress: { part: i + 1, parts: formats.length, bytes: done.reduce((a, b) => a + b, 0), total: Math.max(totals.reduce((a, b) => a + b, 0), done.reduce((a, b) => a + b, 0)) } });
        },
      });
      files.push({ ...file, format: formats[i] });
    }

    // The file's name, from the user's template. Inside a playlist, the playlist's
    // own title for the entry is the better title; numbered by place if wanted.
    const title = (job.playlist && job.title) || info.title;
    const fields = { title, channel: info.channel || info.uploader || '', artist: artistOf(info), track: info.track || title, date: dateOf(info), id: info.id || '' };
    const { index, count } = job.playlist || {};
    const number = job.playlist && settings.numberPlaylist ? String(index).padStart(String(count).length, '0') : '';
    const base = fileName(music ? settings.nameAudio : settings.nameVideo, fields, { number, underscores: settings.underscores });
    const notes = [];

    // Opus: the site's own file, as it is.
    if (music && audioFormat === 'opus' && files.length === 1 && isOpus(files[0].format)) {
      return { title: info.title, notes, files: [{ blob: files[0].blob, cleanup: files[0].cleanup, ext: files[0].ext || 'webm', name: base }] };
    }
    if (music && audioFormat === 'opus') notes.push('There’s no Opus audio for this one: it was saved in the best format there is.');

    // Formats MP4 can't hold (WebM, TS…): keep the original files.
    if (!files.every((f) => f.mp4)) {
      notes.push(music && ['mp3', 'wav'].includes(audioFormat) ? `This audio can’t be converted to ${audioFormat.toUpperCase()}, so the original file was saved as it is.` : 'The best format here can’t be joined into MP4, so the original files were saved as they are.');
      return {
        title: info.title,
        notes,
        files: files.map((f, i) => ({ blob: f.blob, cleanup: f.cleanup, ext: f.ext, name: files.length > 1 ? `${base}.f${f.format.format_id || i}` : base })),
      };
    }

    report({ state: 'writing' });
    const tracks = [];
    for (const f of files) {
      const index = f.index || (await indexBlob(f.blob));
      const read = await readTracks(f.blob, index);
      const onlyFile = files.length === 1;
      const wanted = music ? ['soun'] : f.format.vcodec === 'none' ? ['soun'] : onlyFile ? ['vide', 'soun'] : ['vide'];
      tracks.push(...read.filter((t) => wanted.includes(t.kind)).map((t) => ({ ...t, blob: f.blob })));
    }
    if (!tracks.length) throw new Error('The downloaded file has no usable tracks.');

    if (!music && settings.subtitleTracks?.length) {
      const chosen = chooseTracks(info, settings.subtitleTracks);
      for (let i = 0; i < chosen.length; i++) {
        const t = chosen[i];
        if (i && settings.sleepSubtitles) await sleep(settings.sleepSubtitles, signal);
        try {
          const r = await fetch(t.format.url, { signal, credentials: 'include' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const cues = parseSubtitles(await r.text(), t.format.ext);
          if (cues.length) tracks.push({ kind: 'sbtl', cues, language: t.lang, title: t.name, default: false });
        } catch (e) {
          if (signal?.aborted) throw e;
          notes.push(`Subtitles “${t.name}” couldn’t be downloaded (${e.message}).`);
        }
      }
    }

    // The details written inside the file, as the user chose (settings.meta*).
    const cover = settings.metaCover ? await coverFrom(info, { square: music, signal }) : null;
    const url = info.webpage_url || job.url;
    const meta = {
      ...(settings.metaDetails && {
        title: music ? info.track || info.title : info.title,
        artist: music ? artistOf(info) : info.uploader || info.channel || '',
        album: music ? info.album || '' : '',
        date: dateOf(info),
        genre: info.genre || (info.genres || info.categories || []).join(', '),
      }),
      // The link goes in the comment and as purl, like yt-dlp's --embed-metadata.
      ...(settings.metaLink && { url, comment: url }),
      description: (settings.metaDescription && info.description) || '',
      cover,
    };
    const chapters = settings.metaChapters ? (info.chapters || []).map((c) => ({ start: c.start_time || 0, title: c.title || '' })) : [];
    const cleanup = () => files.forEach((f) => f.cleanup());
    if (music && ['mp3', 'wav'].includes(audioFormat)) {
      report({ state: 'converting', format: audioFormat, progress: { done: 0, total: 1 } });
      const blob = await convertAudio(audioFormat, { track: tracks[0], blob: tracks[0].blob, meta, signal, onProgress: (done, total) => report({ progress: { done, total } }) });
      return { title: info.title, notes, files: [{ blob, ext: audioFormat, name: base, cleanup }] };
    }
    const blob = writeMp4({ tracks, meta, chapters, audioOnly: music });
    return { title: info.title, notes, files: [{ blob, ext: music ? 'm4a' : 'mp4', name: base, cleanup }] };
  } catch (e) {
    files.forEach((f) => f.cleanup());
    throw e;
  }
}

export { sleep };
