/**
 * Image helpers that run in the extension service worker (no DOM): resize and
 * re-encode JPEGs with OffscreenCanvas + createImageBitmap. When those APIs are
 * unavailable (tests, Node) the input is returned unchanged.
 */

export interface EncodedImage {
  data: string;      // base64, no data: prefix
  mediaType: string; // image/jpeg | image/png
  width?: number;
  height?: number;
}

export interface HighlightRect { x: number; y: number; width: number; height: number }

function hasCanvasSupport(): boolean {
  return typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Downscale an image to at most `maxWidth` CSS pixels and re-encode it as JPEG.
 * Optionally draws a highlight rectangle (coordinates in the ORIGINAL image
 * space, scaled with `rectScale`) — used for procedure step thumbnails.
 */
export async function resizeImage(
  img: EncodedImage,
  maxWidth: number,
  quality = 0.7,
  highlight?: { rect: HighlightRect; rectScale?: number }
): Promise<EncodedImage> {
  if (!hasCanvasSupport()) return img;
  try {
    const blob = new Blob([base64ToBytes(img.data) as BlobPart], { type: img.mediaType });
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxWidth / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return img;
    ctx.drawImage(bmp, 0, 0, w, h);
    if (highlight) {
      const s = scale * (highlight.rectScale ?? 1);
      const r = highlight.rect;
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = Math.max(2, Math.round(3 * scale));
      ctx.strokeRect(r.x * s, r.y * s, r.width * s, r.height * s);
    }
    bmp.close?.();
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const bytes = new Uint8Array(await out.arrayBuffer());
    return { data: bytesToBase64(bytes), mediaType: 'image/jpeg', width: w, height: h };
  } catch (err) {
    console.warn('resizeImage failed, using original:', err);
    return img;
  }
}

export function toDataUrl(img: EncodedImage): string {
  return `data:${img.mediaType};base64,${img.data}`;
}

export function fromDataUrl(url: string): EncodedImage | null {
  const m = url.match(/^data:([^;]+);base64,(.*)$/);
  return m ? { mediaType: m[1], data: m[2] } : null;
}
