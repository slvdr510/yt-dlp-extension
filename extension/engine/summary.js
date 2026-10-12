// What the popup shows about a URL, worked out from yt-dlp's info dict.

const host = (url) => {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return '';
  }
};

// Whether a video is music: YouTube Music, an auto-generated "Topic" channel,
// track/artist data, the Music category, or a site that only has audio.
export function isMusic(info) {
  if (host(info.webpage_url) === 'music.youtube.com') return true;
  if (/ - Topic$/.test(info.channel || info.uploader || '')) return true;
  if (info.track || info.artist || info.artists?.length) return true;
  if ((info.categories || []).includes('Music')) return true;
  const formats = info.formats || [];
  return formats.length > 0 && formats.every((f) => f.vcodec === 'none');
}

// Subtitle languages: the ones the creator uploaded, and the automatic captions
// in the video's own language (YouTube auto-translates them into 100+ languages).
export function subtitleChoice(info) {
  const creator = Object.keys(info.subtitles || {}).filter((l) => l !== 'live_chat');
  const auto = Object.keys(info.automatic_captions || {});
  const lang = info.language || '';
  const original = auto.find((l) => l.endsWith('-orig')) || (lang && auto.find((l) => l === lang || l.startsWith(`${lang}-`))) || null;
  return { creator, auto: original };
}

export function summarize(info) {
  if (info._type === 'playlist') {
    return {
      kind: 'playlist',
      title: info.title,
      uploader: info.uploader || info.channel || '',
      count: info.playlist_count ?? info.entries?.length ?? 0,
      extractor: info.extractor_key,
    };
  }
  const heights = [...new Set((info.formats || []).map((f) => f.height).filter(Boolean))].sort((a, b) => b - a);
  return {
    kind: 'video',
    title: info.title,
    uploader: info.uploader || info.channel || '',
    thumbnail: info.thumbnail || null,
    duration: info.duration || 0,
    live: !!info.is_live,
    music: isMusic(info),
    heights,
    subtitles: subtitleChoice(info),
    extractor: info.extractor_key,
  };
}
