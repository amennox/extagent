import type { Page } from "playwright-crx";
import { EncodedImage, resizeImage } from "../../utils/image";

/**
 * Screenshot capture for the MODEL (not only for the user):
 * - CSS-pixel scale (no 2x on HiDPI), JPEG, downscaled to MAX_WIDTH;
 * - optional Set-of-Marks overlay: each [ref] from the interactive map is drawn
 *   as an outlined box with its number, so a vision model can ground "click 12"
 *   in what it sees. The overlay lives in a closed-style shadow root with
 *   pointer-events:none and is removed right after the capture.
 */

export interface MarkRect { ref: number; x: number; y: number; width: number; height: number }

export const SCREENSHOT_MAX_WIDTH = 1280;
/** Hard cap on the base64 payload sent to the model (~600 KB). */
export const MAX_SCREENSHOT_CHARS = 600_000;

const OVERLAY_ID = '__dommotion_marks__';

/** CSS pixels per screenshot pixel of the last capture (to map vision clicks back). */
let lastScale = 1;
export function getLastScreenshotScale(): number {
  return lastScale;
}

function drawMarks(args: { marks: MarkRect[]; id: string }): void {
  const { marks, id } = args;
  document.getElementById(id)?.remove();
  const host = document.createElement('div');
  host.id = id;
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  const colors = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f'];
  for (const m of marks) {
    const color = colors[m.ref % colors.length];
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${m.x}px;top:${m.y}px;width:${m.width}px;height:${m.height}px;`
      + `outline:2px solid ${color};outline-offset:-1px;box-sizing:border-box;`;
    const tag = document.createElement('div');
    const above = m.y >= 16;
    tag.textContent = String(m.ref);
    tag.style.cssText = `position:absolute;left:${Math.max(0, m.x)}px;top:${above ? m.y - 15 : m.y}px;`
      + `background:${color};color:#fff;font:700 11px/14px Arial,sans-serif;padding:0 3px;border-radius:2px;`
      + 'min-width:10px;text-align:center;';
    root.appendChild(box);
    root.appendChild(tag);
  }
  document.documentElement.appendChild(host);
}

function removeMarks(id: string): void {
  document.getElementById(id)?.remove();
}

function bufferToBase64(buffer: any): string {
  if (typeof buffer === 'string') return buffer;
  if (buffer && typeof buffer.toString === 'function' && buffer.constructor?.name !== 'Uint8Array') {
    const s = buffer.toString('base64');
    if (typeof s === 'string' && !s.startsWith('[object')) return s;
  }
  const bytes: Uint8Array = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function captureScreenshot(
  page: Page,
  opts: { marks?: MarkRect[]; fullPage?: boolean; maxWidth?: number; quality?: number } = {}
): Promise<EncodedImage> {
  const maxWidth = opts.maxWidth ?? SCREENSHOT_MAX_WIDTH;
  const marks = opts.marks ?? [];
  if (marks.length) {
    await page.evaluate(drawMarks, { marks, id: OVERLAY_ID }).catch(() => undefined);
  }
  let buffer: any;
  try {
    buffer = await page.screenshot({
      type: 'jpeg',
      quality: opts.quality ?? 70,
      fullPage: !!opts.fullPage,
      scale: 'css',
      animations: 'disabled',
      caret: 'hide',
      timeout: 10_000,
    } as any);
  } finally {
    if (marks.length) await page.evaluate(removeMarks, OVERLAY_ID).catch(() => undefined);
  }
  let img: EncodedImage = { data: bufferToBase64(buffer), mediaType: 'image/jpeg' };
  const cssWidth = page.viewportSize?.()?.width
    ?? (await page.evaluate(() => window.innerWidth).catch(() => undefined) as number | undefined);
  img = await resizeImage(img, maxWidth, 0.7);
  // Still too heavy (e.g. full page): shrink further
  for (const w of [1024, 800, 640]) {
    if (img.data.length <= MAX_SCREENSHOT_CHARS) break;
    img = await resizeImage(img, w, 0.55);
  }
  lastScale = cssWidth && img.width ? cssWidth / img.width : 1;
  if (img.data.length > MAX_SCREENSHOT_CHARS) {
    throw new Error(`screenshot too large (${img.data.length} chars) even after downscaling`);
  }
  return img;
}
