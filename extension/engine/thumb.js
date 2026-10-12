// The cover image: the video's best thumbnail as a JPEG, cropped to a square for
// music (album art). Browser only (uses OffscreenCanvas).

function bestThumbnail(info) {
  const list = (info.thumbnails || []).filter((t) => t.url && !/\.(svg)$/i.test(t.url));
  // yt-dlp lists thumbnails worst first; prefer the largest with known size.
  const sized = list.filter((t) => t.width && t.height).sort((a, b) => b.width * b.height - a.width * a.height);
  return sized[0]?.url || list[list.length - 1]?.url || info.thumbnail || null;
}

export async function coverFrom(info, { square = false, signal } = {}) {
  const url = bestThumbnail(info);
  if (!url) return null;
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) return null;
    const bitmap = await createImageBitmap(await r.blob());
    let w = bitmap.width;
    let h = bitmap.height;
    let sx = 0;
    let sy = 0;
    if (square) {
      const side = Math.min(w, h);
      sx = (w - side) / 2;
      sy = (h - side) / 2;
      w = h = side;
    }
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bitmap, sx, sy, w, h, 0, 0, w, h);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    return { bytes: new Uint8Array(await jpeg.arrayBuffer()), type: 'jpeg' };
  } catch (e) {
    return null; // no cover is better than no file
  }
}
