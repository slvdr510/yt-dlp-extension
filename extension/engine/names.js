// File names that are safe on Windows, macOS and Linux.
export function cleanName(s, fallback = 'video') {
  let v = (s || '')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]+/gu, '')
    .replace(/[\\/:*?"<>|~\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150)
    .trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(v)) v += '_';
  return v || fallback;
}

// What a file name template can hold, as {field}.
export const NAME_FIELDS = {
  title: 'the video’s title',
  channel: 'who uploaded it',
  artist: 'the song’s artist (else the channel)',
  track: 'the song’s name (else the title)',
  date: 'when it came out (2024-05-31)',
  id: 'the site’s ID for it',
};

// A file's name (no extension) from a template such as "{artist} - {track}". Empty
// fields take their separators with them. `number` ("01") goes in front;
// `underscores` replaces the spaces.
export function fileName(template, fields, { number = '', underscores = false } = {}) {
  const filled = (template?.trim() || '{title}')
    .replace(/\{(\w+)\}/g, (m, key) => (key in NAME_FIELDS ? cleanName(fields[key], '') : m))
    .replace(/(\s*[-–—|·,]\s*){2,}/g, ' - ')
    .replace(/^[\s\-–—|·,_.]+|[\s\-–—|·,_.]+$/g, '');
  const name = cleanName(number ? `${number} - ${filled}` : filled, cleanName(fields.title));
  return underscores ? name.replaceAll(' ', '_') : name;
}
