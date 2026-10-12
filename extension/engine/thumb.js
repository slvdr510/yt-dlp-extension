// The cover image: the video's best thumbnail as a JPEG. For music, album art
// framed in plain side bars (YouTube Music's thumbnails) is cropped to a square.
// Browser only (uses OffscreenCanvas).

// Whether the parts a centred square crop would cut off are plain (bars, not
// picture). `image`: { data, width, height } as from getImageData.
export function plainSides({ data, width, height }) {
  const side = Math.floor((width - height) / 2) - 1; // the column at the edge can blend
  if (side < 1) return false;
  for (const x0 of [0, width - side]) {
    let sum = 0;
    let sq = 0;
    let n = 0;
    for (let y = 0; y < height; y++) {
      for (let x = x0; x < x0 + side; x++) {
        const i = (y * width + x) * 4;
        const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        sum += l;
        sq += l * l;
        n++;
      }
    }
    if (Math.sqrt(sq / n - (sum / n) ** 2) > 12) return false;
  }
  return true;
}

// Looks for plain sides on a small copy (fast, and smooths JPEG noise).
function isFramedSquare(bitmap) {
  const w = 64;
  const h = Math.max(1, Math.round((bitmap.height / bitmap.width) * w));
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return plainSides(ctx.getImageData(0, 0, w, h));
}

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
    if (square && w > h && isFramedSquare(bitmap)) {
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
