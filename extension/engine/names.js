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
