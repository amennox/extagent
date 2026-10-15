import type { Page, Frame } from "playwright-crx";
import { ActionLog } from "../../tracking/actionLog";
import { captureScreenshot, MarkRect } from "./screenshot";
import { settleAfterAction } from "./stability";
import { ToolOutput } from "./types";
import { truncate, withActivePage } from "./utils";

/**
 * Page perception ("set of marks").
 *
 * `browser_observe` scans the page (main frame + child frames + open shadow
 * roots) and returns a NUMBERED list of the visible interactive elements, the
 * page messages (toasts, validation errors), and where the viewport is on the
 * page (what is above/below the fold). On vision models it also returns a
 * screenshot with the same numbers drawn on the elements, so the model sees
 * layout and refs together.
 *
 * Each scanned element is tagged in the DOM with `data-dm-ref`, so acting on a
 * ref targets exactly that element (stable CSS candidates are kept as a
 * fallback and for replayable procedures). After every ref action the page is
 * rescanned and a DIFF is returned, closing the observe→act loop cheaply.
 */

export interface MapRect { x: number; y: number; width: number; height: number }

export interface MapEntry {
  ref: number;
  role: string;
  label: string;
  value?: string;
  state?: string;
  candidates: string[];
  /** Viewport rect in main-frame coordinates (for Set-of-Marks) */
  rect?: MapRect;
  /** HTML input type (password detection) */
  inputType?: string;
  /** 0 = main frame */
  frameIndex?: number;
  frameUrl?: string;
}

export interface ScrollInfo {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** The page scrolls inside an inner container instead of the document */
  inner: boolean;
}

export interface PageMap {
  url: string;
  title?: string;
  entries: MapEntry[];
  /** Visible non-interactive signals: toasts, validation errors, alerts */
  alerts: string[];
  scroll?: ScrollInfo;
  /** Interactive elements outside the viewport (not numbered) */
  above?: number;
  below?: number;
  /** Elements hidden behind an open modal dialog */
  covered?: number;
  /** Elements beyond the per-scan cap */
  truncated?: number;
  /** Frames referenced by entries (index → frame), not serialized */
  frames?: Array<Page | Frame>;
}

// Module-level registry (one agent per window, same pattern as ScreenshotManager)
let currentMap: PageMap | null = null;
let visionEnabled = false;
/** Identity key → ref for every element seen on the current page */
let refRegistry: { url: string; byFrame: Map<string, Record<string, number>>; maxRef: number } | null = null;

/** Enable Set-of-Marks screenshots in observations (vision-capable models). */
export function setVisionEnabled(enabled: boolean): void {
  visionEnabled = enabled;
}

export function isVisionEnabled(): boolean {
  return visionEnabled;
}

export function getCurrentMap(): PageMap | null {
  return currentMap;
}

export function getMapEntry(ref: number): MapEntry | undefined {
  return currentMap?.entries.find(e => e.ref === ref);
}

/** For tests */
export function _setCurrentMap(map: Partial<PageMap> & { url: string; entries: MapEntry[] } | null): void {
  currentMap = map ? { alerts: [], ...map } : null;
  if (!map) refRegistry = null;
}

interface ScanArgs {
  /** First ref number for elements not seen in the previous scan */
  startRef: number;
  /** Identity key → ref from the previous scan of the same page (stable refs) */
  prev: Record<string, number>;
  max: number;
  margin: number;
  /** Offset of this frame inside the main viewport (child frames) */
  offsetX: number;
  offsetY: number;
  /** Main viewport height, for visibility of child-frame elements */
  mainViewportH: number;
  isMain: boolean;
}

interface ScanResult {
  elements: Array<Omit<MapEntry, 'ref'> & { ref?: number }>;
  alerts: string[];
  scroll?: ScrollInfo;
  above?: number;
  below?: number;
  covered?: number;
  truncated?: number;
  title?: string;
  nextRef?: number;
}

/** In-page scan: runs inside the page via evaluate. MUST be self-contained. */
function scanInteractiveElements(args: ScanArgs): ScanResult {
  const { startRef, prev, max, margin, offsetX, offsetY, mainViewportH, isMain } = args;
  const usedRefs = new Set<number>();
  const results: ScanResult['elements'] = [];
  const seen = new Set<Element>();
  let above = 0;
  let below = 0;
  let covered = 0;
  let truncated = 0;

  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cssEscape = (v: string) =>
    (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(v) : v.replace(/([^a-zA-Z0-9_-])/g, '\\$1');

  // Collect from the document and every open shadow root
  const roots: Array<Document | ShadowRoot> = [document];
  const allEls = document.querySelectorAll('*');
  const hostLimit = Math.min(allEls.length, 8000);
  for (let i = 0; i < hostLimit; i++) {
    const sr = (allEls[i] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (sr) {
      roots.push(sr);
      const inner = sr.querySelectorAll('*');
      for (let j = 0; j < inner.length && j < 2000; j++) {
        const sr2 = (inner[j] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (sr2) roots.push(sr2);
      }
    }
  }

  // Clear refs from a previous scan
  for (const root of roots) {
    root.querySelectorAll('[data-dm-ref]').forEach(el => el.removeAttribute('data-dm-ref'));
  }

  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;

  // Open modal dialog: elements behind it are not reachable
  const modal = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]'))
    .filter(d => {
      const r = (d as HTMLElement).getBoundingClientRect();
      const st = window.getComputedStyle(d as HTMLElement);
      return r.width > 50 && r.height > 50 && st.display !== 'none' && st.visibility !== 'hidden';
    })
    .pop() ?? null;

  const isRendered = (el: Element): boolean => {
    const rect = (el as HTMLElement).getBoundingClientRect?.();
    if (!rect || rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el as HTMLElement);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return true;
  };

  const textOf = (el: Element | null): string =>
    ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const labelFor = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = el.getRootNode() as Document | ShadowRoot;
      const txt = labelledBy.split(/\s+/)
        .map(id => textOf((root as Document).getElementById?.(id) ?? document.getElementById(id)))
        .filter(Boolean).join(' ');
      if (txt) return txt;
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      const txt = textOf(labels[0]);
      if (txt) return txt;
    }
    const wrapping = el.closest('label');
    if (wrapping && textOf(wrapping)) return textOf(wrapping);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
      const text = textOf(el);
      if (text) return text;
      const img = el.querySelector('img[alt], svg[aria-label], [title]');
      const alt = img?.getAttribute('alt') ?? img?.getAttribute('aria-label') ?? img?.getAttribute('title');
      if (alt) return alt;
    }
    return el.getAttribute('title') ?? el.getAttribute('name') ?? el.getAttribute('id') ?? '';
  };

  const candidatesFor = (el: Element): string[] => {
    const tag = el.tagName.toLowerCase();
    const cands: string[] = [];
    const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-cy');
    if (testId) cands.push(`[data-testid="${esc(testId)}"]`);
    const name = el.getAttribute('name');
    if (name) cands.push(`${tag}[name="${esc(name)}"]`);
    if (el.id && !/\d{3,}|^[a-f0-9-]{16,}$/i.test(el.id)) cands.push(`#${cssEscape(el.id)}`);
    const aria = el.getAttribute('aria-label');
    if (aria) cands.push(`${tag}[aria-label="${esc(aria)}"]`);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) cands.push(`${tag}[placeholder="${esc(placeholder)}"]`);
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
      if (cur.id) { parts.unshift(`#${cssEscape(cur.id)}`); break; }
      let part = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(s => s.tagName === cur!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    const path = parts.join(' > ');
    if (path && !cands.includes(path)) cands.push(path);
    return cands;
  };

  const roleFor = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      if (['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'date', 'range'].includes(type)) return type === 'reset' ? 'button' : type;
      return 'textbox';
    }
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    return tag;
  };

  const selector = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="combobox"], [role="option"], [role="treeitem"], [role="gridcell"][tabindex], [onclick], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

  const nodes: Element[] = [];
  for (const root of roots) nodes.push(...Array.from(root.querySelectorAll(selector)));

  const nativeInvalid: string[] = [];
  let nextRef = startRef;
  for (const el of nodes) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (el instanceof HTMLInputElement && el.type === 'hidden') continue;
    // Skip generic tabindex containers that wrap other interactive elements
    if (el.matches('[tabindex]') && !el.matches('a, button, input, select, textarea, [role], [onclick], [contenteditable="true"]')
      && el.querySelector('a, button, input, select, textarea')) continue;
    if (!isRendered(el)) continue;

    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.right < 0 || r.left > viewportW) continue;
    // Position in the main viewport (child frames are offset)
    const top = r.top + offsetY;
    const bottom = r.bottom + offsetY;
    const vh = isMain ? viewportH : mainViewportH;
    if (bottom < -margin) { above++; continue; }
    if (top > vh + margin) { below++; continue; }

    if (modal && !modal.contains(el) && !(el.getRootNode() as ShadowRoot).host) {
      covered++;
      continue;
    }

    const role = roleFor(el);
    const label = labelFor(el).replace(/\s+/g, ' ').slice(0, 80);
    if (!label && role !== 'textbox' && role !== 'select' && role !== 'combobox') continue; // unlabeled non-inputs are noise

    if (results.length >= max) { truncated++; continue; }

    let value: string | undefined;
    const states: string[] = [];
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') states.push(el.checked ? 'checked' : 'unchecked');
      else if (el.type !== 'password') value = el.value?.slice(0, 60) || undefined;
      else value = el.value ? '•••' : undefined;
      if (el.required) states.push('required');
    } else if (el instanceof HTMLTextAreaElement) {
      value = el.value?.slice(0, 60) || undefined;
      if (el.required) states.push('required');
    } else if (el instanceof HTMLSelectElement) {
      value = el.selectedOptions?.[0]?.textContent?.trim().slice(0, 60) || undefined;
      if (el.required) states.push('required');
    } else if ((el as HTMLElement).isContentEditable) {
      value = textOf(el).slice(0, 60) || undefined;
    }
    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked && !(el instanceof HTMLInputElement)) states.push(ariaChecked === 'true' ? 'checked' : 'unchecked');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) states.push(expanded === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-selected') === 'true') states.push('selected');
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
    if (el.getAttribute('aria-required') === 'true' && !states.includes('required')) states.push('required');
    let userInvalid = false;
    try { userInvalid = el.matches(':user-invalid'); } catch { /* unsupported selector */ }
    if (el.getAttribute('aria-invalid') === 'true' || userInvalid) states.push('invalid');
    if (userInvalid && (el as HTMLInputElement).validationMessage) {
      nativeInvalid.push(`Field "${label || roleFor(el)}": ${(el as HTMLInputElement).validationMessage}`);
    }

    // Stable refs: an element seen in the previous scan keeps its number
    const candidates = candidatesFor(el);
    const key = `${role}|${label}|${candidates[0] ?? ''}`;
    let ref = prev[key];
    if (ref === undefined || usedRefs.has(ref)) ref = nextRef++;
    usedRefs.add(ref);
    el.setAttribute('data-dm-ref', String(ref));
    results.push({
      ref,
      role,
      label,
      value,
      state: states.length ? states.join(',') : undefined,
      candidates,
      inputType: el instanceof HTMLInputElement ? el.type : undefined,
      rect: { x: Math.round(r.left + offsetX), y: Math.round(top), width: Math.round(r.width), height: Math.round(r.height) },
    });
  }

  // Non-interactive signals the agent MUST see: toasts, validation errors,
  // alert banners. Without these, a failed save looks like "no changes".
  const alerts: string[] = nativeInvalid.slice(0, 4);
  const alertSelector = '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"], .Toastify__toast, [class*="toast"], [class*="Toast"], [class*="snackbar"], [class*="alert-"], .invalid-feedback, .error-message, [class*="error-message"], [class*="errorMessage"], [id$="-form-item-message"]';
  for (const el of Array.from(document.querySelectorAll(alertSelector))) {
    if (!isRendered(el)) continue;
    const text = textOf(el);
    if (text && text.length > 1 && !alerts.includes(text)) {
      alerts.push(text.slice(0, 200));
      if (alerts.length >= 6) break;
    }
  }

  // Where is the viewport? Some apps scroll an inner container, not the document
  let scroll: ScrollInfo | undefined;
  if (isMain) {
    const se = (document.scrollingElement ?? document.documentElement) as HTMLElement;
    let scroller: HTMLElement = se;
    let inner = false;
    if (se.scrollHeight <= viewportH + 4) {
      let best: HTMLElement | null = null;
      let bestArea = 0;
      const els = document.querySelectorAll('body *');
      const lim = Math.min(els.length, 5000);
      for (let i = 0; i < lim; i++) {
        const e = els[i] as HTMLElement;
        if (e.scrollHeight <= e.clientHeight + 20 || e.clientHeight < 100) continue;
        const oy = window.getComputedStyle(e).overflowY;
        if (oy !== 'auto' && oy !== 'scroll') continue;
        const area = e.clientWidth * e.clientHeight;
        if (area > bestArea) { best = e; bestArea = area; }
      }
      if (best) { scroller = best; inner = true; }
    }
    scroll = {
      scrollTop: Math.round(scroller.scrollTop),
      scrollHeight: Math.round(scroller.scrollHeight),
      clientHeight: Math.round(inner ? scroller.clientHeight : viewportH),
      inner,
    };
  }

  return { elements: results, alerts, scroll, above, below, covered, truncated, title: document.title, nextRef };
}

const MAX_ELEMENTS = 150;
const VIEWPORT_MARGIN = 150;

export function entryKey(e: Pick<MapEntry, 'role' | 'label' | 'candidates'>): string {
  return `${e.role}|${e.label}|${e.candidates[0] ?? ''}`;
}

function samePage(a: string | undefined, b: string): boolean {
  if (!a) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}

export async function buildMap(page: Page): Promise<PageMap> {
  const mainViewportH = (page.viewportSize?.()?.height) ?? 800;
  const url = page.url();
  // Keep ref numbers stable while we stay on the same page (even for elements
  // that disappear and come back, e.g. form tabs); restart at 1 on a new page.
  if (!refRegistry || !samePage(refRegistry.url, url)) {
    refRegistry = { url, byFrame: new Map(), maxRef: 0 };
  }
  const prevByFrame = refRegistry.byFrame;
  const maxRef = refRegistry.maxRef;
  let nextRef = maxRef + 1;
  const raw = (await page.evaluate(scanInteractiveElements, {
    startRef: nextRef, prev: prevByFrame.get('') ?? {}, max: MAX_ELEMENTS, margin: VIEWPORT_MARGIN,
    offsetX: 0, offsetY: 0, mainViewportH, isMain: true,
  } as ScanArgs)) as ScanResult;
  nextRef = raw.nextRef ?? nextRef + (raw.elements?.length ?? 0);

  const frames: Array<Page | Frame> = [page];
  const entries: MapEntry[] = (raw.elements ?? []).map((e, i) => ({ ...e, ref: e.ref ?? i + 1, frameIndex: 0 }));
  const alerts = [...(raw.alerts ?? [])];
  let above = raw.above ?? 0;
  let below = raw.below ?? 0;
  let covered = raw.covered ?? 0;
  let truncated = raw.truncated ?? 0;

  // Child frames (same- and cross-origin): many enterprise portals use iframes
  const childFrames = typeof page.frames === 'function'
    ? page.frames().filter(f => f !== page.mainFrame?.()).slice(0, 8)
    : [];
  for (const frame of childFrames) {
    if (entries.length >= MAX_ELEMENTS) break;
    try {
      const handle = await frame.frameElement();
      const box = await handle.boundingBox();
      if (!box || box.width < 20 || box.height < 20) continue;
      const res = (await frame.evaluate(scanInteractiveElements, {
        startRef: nextRef,
        prev: prevByFrame.get(frame.url()) ?? {},
        max: MAX_ELEMENTS - entries.length,
        margin: VIEWPORT_MARGIN,
        offsetX: Math.round(box.x),
        offsetY: Math.round(box.y),
        mainViewportH,
        isMain: false,
      } as ScanArgs)) as ScanResult;
      nextRef = res.nextRef ?? nextRef + (res.elements?.length ?? 0);
      const frameIndex = frames.length;
      frames.push(frame);
      for (const e of res.elements ?? []) {
        entries.push({ ...e, ref: e.ref ?? entries.length + 1, frameIndex, frameUrl: frame.url() });
      }
      alerts.push(...(res.alerts ?? []).filter(a => !alerts.includes(a)));
      above += res.above ?? 0;
      below += res.below ?? 0;
      covered += res.covered ?? 0;
      truncated += res.truncated ?? 0;
    } catch {
      // detached or inaccessible frame — skip
    }
  }

  for (const e of entries) {
    const fk = e.frameUrl ?? '';
    if (!prevByFrame.has(fk)) prevByFrame.set(fk, {});
    prevByFrame.get(fk)![entryKey(e)] = e.ref;
    refRegistry.maxRef = Math.max(refRegistry.maxRef, e.ref);
  }

  return {
    url,
    title: raw.title,
    entries,
    alerts: alerts.slice(0, 8),
    scroll: raw.scroll,
    above, below, covered, truncated,
    frames,
  };
}

export function formatEntry(e: MapEntry): string {
  const value = e.value !== undefined ? ` = "${e.value}"` : '';
  const state = e.state ? ` (${e.state})` : '';
  const frame = e.frameIndex ? ' [iframe]' : '';
  return `[${e.ref}] ${e.role} "${e.label}"${value}${state}${frame}`;
}

export function formatMap(entries: MapEntry[]): string {
  if (entries.length === 0) return 'No interactive elements visible.';
  return entries.map(formatEntry).join('\n');
}

/** One-line description of the viewport position and off-screen content. */
export function formatScrollInfo(map: Pick<PageMap, 'scroll' | 'above' | 'below' | 'covered' | 'truncated'>): string {
  const parts: string[] = [];
  const s = map.scroll;
  if (s && s.scrollHeight > s.clientHeight + 4) {
    const seenTo = Math.min(100, Math.round(((s.scrollTop + s.clientHeight) / s.scrollHeight) * 100));
    const from = Math.round((s.scrollTop / s.scrollHeight) * 100);
    parts.push(`Viewport shows ${from}–${seenTo}% of the page${s.inner ? ' (inner scroll container)' : ''}`);
  } else {
    parts.push('Whole page fits in the viewport');
  }
  if (map.below) parts.push(`${map.below} more interactive elements BELOW (browser_scroll down to see them)`);
  if (map.above) parts.push(`${map.above} ABOVE`);
  if (map.covered) parts.push(`${map.covered} hidden behind the open dialog`);
  if (map.truncated) parts.push(`${map.truncated} not listed (cap reached)`);
  return parts.join(' · ');
}

export function formatObservation(map: PageMap): string {
  const header = `Page: ${map.title ? `"${map.title}" ` : ''}${map.url}`;
  const alertsBlock = map.alerts.length
    ? `\n\n⚠ PAGE MESSAGES:\n${map.alerts.map(a => `! ${a}`).join('\n')}`
    : '';
  return truncate(`${header}\n${formatScrollInfo(map)}\nInteractive elements (act with the [number]):\n${formatMap(map.entries)}${alertsBlock}`);
}

/** Diff of page messages (toasts/validation errors) between two scans. */
export function diffAlerts(before: string[], after: string[]): string[] {
  return after.filter(a => !before.includes(a));
}

/** Diff two maps by role+label identity — compact "what changed" summary. */
export function diffMaps(before: MapEntry[], after: MapEntry[]): string {
  const key = (e: MapEntry) => `${e.role}|${e.label}`;
  const beforeKeys = new Map(before.map(e => [key(e), e]));
  const afterKeys = new Map(after.map(e => [key(e), e]));

  const added = after.filter(e => !beforeKeys.has(key(e)));
  const removed = before.filter(e => !afterKeys.has(key(e)));
  const valueChanged = after.filter(e => {
    const prev = beforeKeys.get(key(e));
    return prev && (prev.value !== e.value || prev.state !== e.state);
  });

  if (added.length === 0 && removed.length === 0 && valueChanged.length === 0) {
    return 'no visible changes';
  }
  const lines: string[] = [];
  for (const e of added.slice(0, 12)) lines.push(`+ ${formatEntry(e)}`);
  if (added.length > 12) lines.push(`+ …and ${added.length - 12} more new elements`);
  for (const e of removed.slice(0, 5)) lines.push(`- ${e.role} "${e.label}"`);
  if (removed.length > 5) lines.push(`- …and ${removed.length - 5} more removed`);
  for (const e of valueChanged.slice(0, 6)) lines.push(`~ ${formatEntry(e)}`);
  return lines.join('\n');
}

interface ResolvedRef {
  frame: Page | Frame;
  selector: string;
  entry: MapEntry;
}

async function resolveRef(page: Page, ref: number, timeoutMs = 3000): Promise<ResolvedRef | null> {
  const entry = getMapEntry(ref);
  if (!entry) return null;
  const frame = currentMap?.frames?.[entry.frameIndex ?? 0] ?? page;
  const selectors = [`[data-dm-ref="${ref}"]`, ...entry.candidates];
  const per = Math.max(400, Math.floor(timeoutMs / selectors.length));
  for (const selector of selectors) {
    try {
      const el = await frame.waitForSelector(selector, { timeout: per, state: 'attached' });
      if (el) return { frame, selector, entry };
    } catch { /* next candidate */ }
  }
  return null;
}

/** Click with progressive fallbacks for overlays and off-viewport elements. */
async function robustClick(frame: Page | Frame, selector: string): Promise<string> {
  try {
    await frame.click(selector, { timeout: 4000 });
    return '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/intercept|not visible|outside of the viewport|not stable|Timeout/i.test(msg)) throw err;
    try {
      await frame.click(selector, { timeout: 2000, force: true });
      return ' (forced click: another element was covering it)';
    } catch {
      await frame.$eval(selector, (el: Element) => (el as HTMLElement).click());
      return ' (DOM click fallback)';
    }
  }
}

/** Shared post-action epilogue: settle + rescan + diff (elements AND page messages). */
export async function afterRefAction(page: Page, actionDetail: string): Promise<string> {
  const urlBefore = currentMap?.url;
  const settle = await settleAfterAction(page);
  try {
    const beforeEntries = currentMap?.entries ?? [];
    const beforeAlerts = currentMap?.alerts ?? [];
    const fresh = await buildMap(page);
    currentMap = fresh; // refs stay valid for the *new* state
    const newAlerts = diffAlerts(beforeAlerts, fresh.alerts);
    const alertText = newAlerts.length > 0
      ? `\n⚠ PAGE MESSAGES:\n${newAlerts.map(a => `! ${a}`).join('\n')}`
      : '';
    if (urlBefore && fresh.url !== urlBefore) {
      return `${actionDetail} · ${settle}\nNavigated to a new page.\n${formatObservation(fresh)}${alertText}`;
    }
    return `${actionDetail} · ${settle}\nChanges:\n${diffMaps(beforeEntries, fresh.entries)}${alertText}`;
  } catch {
    return `${actionDetail} · ${settle}\nChanges: diff unavailable`;
  }
}

/** Observation with optional Set-of-Marks screenshot (vision models). */
export async function observePage(activePage: Page, opts: { screenshot?: boolean } = {}): Promise<ToolOutput> {
  return observe(activePage, opts);
}

async function observe(activePage: Page, opts: { screenshot?: boolean } = {}): Promise<ToolOutput> {
  const map = await buildMap(activePage);
  currentMap = map;
  const text = formatObservation(map);
  const wantImage = opts.screenshot ?? visionEnabled;
  if (!wantImage) return { text };
  try {
    const marks: MarkRect[] = map.entries
      .filter(e => e.rect)
      .map(e => ({ ref: e.ref, ...e.rect! }));
    const shot = await captureScreenshot(activePage, { marks });
    return { text: `${text}\n\n(Screenshot attached: the [numbers] drawn on the page match the list above.)`, image: shot };
  } catch (err) {
    return { text: `${text}\n\n(screenshot unavailable: ${err instanceof Error ? err.message : String(err)})` };
  }
}

const NO_MAP_MSG = 'Error: no interactive map. Call browser_observe first.';
const badRef = (ref: number) => `Error: ref [${ref}] not found in the current map (the page may have changed). Call browser_observe to refresh.`;

function parseArgs(input: string): Record<string, any> | null {
  const trimmed = (input ?? '').trim();
  if (!trimmed.startsWith('{')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

export function browserObserve(page: Page) {
  return {
    name: 'browser_observe',
    description: 'Observe the current page: numbered interactive elements, page messages, scroll position; on vision models also an annotated screenshot.',
    func: async (input: string): Promise<ToolOutput> => {
      const args = parseArgs(input) ?? {};
      const screenshot = typeof args.screenshot === 'boolean'
        ? args.screenshot
        : /screenshot|image|true/i.test(input ?? '') ? true : undefined;
      try {
        return await withActivePage(page, (activePage) => observe(activePage, { screenshot }));
      } catch (err) {
        return { text: `Error observing page: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

/** Legacy alias: text-only observation. */
export function browserInteractiveMap(page: Page) {
  return {
    name: 'browser_interactive_map',
    description: 'Scan the page and return a numbered list of visible interactive elements (buttons, links, fields). Prefer browser_observe.',
    func: async (): Promise<string> => {
      try {
        return await withActivePage(page, async (activePage) => (await observe(activePage, { screenshot: false })).text);
      } catch (err) {
        return `Error building interactive map: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function browserScroll(page: Page) {
  return {
    name: 'browser_scroll',
    description: 'Scroll the page (or its inner scroll container) and return the new observation. Input: JSON {direction: "down"|"up"|"top"|"bottom", ref?: number}.',
    func: async (input: string): Promise<ToolOutput> => {
      const args = parseArgs(input) ?? { direction: (input ?? '').trim() || 'down' };
      const direction = String(args.direction ?? 'down').toLowerCase();
      const ref = args.ref !== undefined ? Number(args.ref) : NaN;
      try {
        return await withActivePage(page, async (activePage) => {
          let detail: string;
          if (!isNaN(ref)) {
            const resolved = await resolveRef(activePage, ref);
            if (!resolved) return { text: badRef(ref) };
            await resolved.frame.$eval(resolved.selector, (el: Element) => el.scrollIntoView({ block: 'center' }));
            detail = `Scrolled element [${ref}] into view`;
          } else {
            const moved = await activePage.evaluate((dir: string) => {
              const se = (document.scrollingElement ?? document.documentElement) as HTMLElement;
              let scroller: HTMLElement = se;
              if (se.scrollHeight <= window.innerHeight + 4) {
                let bestArea = 0;
                for (const e of Array.from(document.querySelectorAll('body *')).slice(0, 5000) as HTMLElement[]) {
                  if (e.scrollHeight <= e.clientHeight + 20 || e.clientHeight < 100) continue;
                  const oy = window.getComputedStyle(e).overflowY;
                  if (oy !== 'auto' && oy !== 'scroll') continue;
                  const area = e.clientWidth * e.clientHeight;
                  if (area > bestArea) { scroller = e; bestArea = area; }
                }
              }
              const isDoc = scroller === se;
              const page = isDoc ? window.innerHeight : scroller.clientHeight;
              const before = scroller.scrollTop;
              if (dir === 'top') scroller.scrollTop = 0;
              else if (dir === 'bottom') scroller.scrollTop = scroller.scrollHeight;
              else scroller.scrollTop = before + (dir === 'up' ? -1 : 1) * Math.round(page * 0.8);
              return Math.round(scroller.scrollTop - before);
            }, direction);
            detail = moved === 0
              ? `Cannot scroll ${direction}: already at the ${direction === 'up' || direction === 'top' ? 'top' : 'bottom'}`
              : `Scrolled ${direction} by ${Math.abs(moved as number)}px`;
          }
          await settleAfterAction(activePage).catch(() => undefined);
          const obs = await observe(activePage);
          return { ...obs, text: `${detail}\n${obs.text}` };
        });
      } catch (err) {
        return { text: `Error scrolling: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };
}

function parseRefAndText(input: string, key: 'text' | 'option'): { ref: number; text: string; submit?: boolean } | null {
  const args = parseArgs(input);
  if (args) {
    const ref = Number(args.ref);
    if (isNaN(ref)) return null;
    return { ref, text: String(args[key] ?? args.text ?? args.value ?? ''), submit: args.submit === true };
  }
  const sep = input.indexOf('|');
  if (sep < 0) return null;
  const ref = parseInt(input.slice(0, sep).trim(), 10);
  if (isNaN(ref)) return null;
  return { ref, text: key === 'option' ? input.slice(sep + 1).trim() : input.slice(sep + 1) };
}

export function browserClickRef(page: Page) {
  return {
    name: 'browser_click_ref',
    description: 'Click an element by its number from browser_observe. Input: the ref number (e.g. 12).',
    func: async (input: string): Promise<string> => {
      const args = parseArgs(input);
      const ref = args ? Number(args.ref) : parseInt((input ?? '').trim(), 10);
      if (isNaN(ref)) return 'Error: input must be a ref number from browser_observe.';
      try {
        return await withActivePage(page, async (activePage) => {
          if (!currentMap) return NO_MAP_MSG;
          const resolved = await resolveRef(activePage, ref);
          if (!resolved) return badRef(ref);
          const note = await robustClick(resolved.frame, resolved.selector);
          ActionLog.push({
            type: 'click', selector: resolved.entry.candidates[0], candidates: resolved.entry.candidates,
            elementText: resolved.entry.label, role: resolved.entry.role, frameUrl: resolved.entry.frameUrl,
            pageUrl: currentMap?.url, description: `click "${resolved.entry.label}"`,
          });
          return await afterRefAction(activePage, `Clicked [${ref}] ${resolved.entry.role} "${resolved.entry.label}"${note}`);
        });
      } catch (err) {
        return `Error clicking ref [${ref}]: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function browserFillRef(page: Page) {
  return {
    name: 'browser_fill_ref',
    description: 'Fill a field by its number from browser_observe. Input: JSON {ref, text, submit?} or "ref|text".',
    func: async (input: string): Promise<string> => {
      const parsed = parseRefAndText(input ?? '', 'text');
      if (!parsed) return 'Error: input must be {"ref": n, "text": "..."} or "ref|text".';
      const { ref, text, submit } = parsed;
      try {
        return await withActivePage(page, async (activePage) => {
          if (!currentMap) return NO_MAP_MSG;
          const resolved = await resolveRef(activePage, ref);
          if (!resolved) return badRef(ref);
          // fill() dispatches proper input events — works with React/Vue controlled inputs
          await resolved.frame.fill(resolved.selector, text, { timeout: 4000 });
          if (submit) await resolved.frame.press(resolved.selector, 'Enter', { timeout: 4000 });
          ActionLog.push({
            type: 'type', selector: resolved.entry.candidates[0], candidates: resolved.entry.candidates,
            text, elementLabel: resolved.entry.label, role: resolved.entry.role, frameUrl: resolved.entry.frameUrl,
            inputType: resolved.entry.inputType,
            pageUrl: currentMap?.url, description: `type in "${resolved.entry.label}"`,
          });
          if (submit) {
            ActionLog.push({
              type: 'press', selector: resolved.entry.candidates[0], candidates: resolved.entry.candidates, text: 'Enter',
              elementLabel: resolved.entry.label, frameUrl: resolved.entry.frameUrl, description: `Enter in "${resolved.entry.label}"`,
            });
          }
          const shown = resolved.entry.inputType === 'password' || /password/i.test(resolved.entry.label) ? '•••' : text;
          return await afterRefAction(activePage, `Filled [${ref}] "${resolved.entry.label}" with "${shown}"${submit ? ' and pressed Enter' : ''}`);
        });
      } catch (err) {
        return `Error filling ref [${ref}]: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function browserSelectRef(page: Page) {
  return {
    name: 'browser_select_ref',
    description: 'Select an option in a dropdown (native <select> or custom combobox) by its number from browser_observe. Input: JSON {ref, option} or "ref|option".',
    func: async (input: string): Promise<string> => {
      const parsed = parseRefAndText(input ?? '', 'option');
      if (!parsed) return 'Error: input must be {"ref": n, "option": "..."} or "ref|option".';
      const { ref, text: option } = parsed;
      try {
        return await withActivePage(page, async (activePage) => {
          if (!currentMap) return NO_MAP_MSG;
          const resolved = await resolveRef(activePage, ref);
          if (!resolved) return badRef(ref);
          const { frame, selector, entry } = resolved;
          const isNative = await frame.$eval(selector, (el: Element) => el.tagName === 'SELECT').catch(() => false);
          let how = '';
          if (isNative) {
            try {
              await frame.selectOption(selector, { label: option });
            } catch {
              try {
                await frame.selectOption(selector, { value: option });
              } catch {
                // Partial label match
                const values = await frame.$eval(selector, (el: Element, wanted: string) => {
                  const w = wanted.toLowerCase();
                  const opt = Array.from((el as HTMLSelectElement).options).find(o => o.text.toLowerCase().includes(w));
                  return opt ? [opt.value] : [];
                }, option);
                if (!(values as string[]).length) throw new Error(`option "${option}" not found`);
                await frame.selectOption(selector, (values as string[])[0]);
              }
            }
          } else {
            // Custom dropdown: open it, then click the matching option
            await robustClick(frame, selector);
            await settleAfterAction(activePage).catch(() => undefined);
            const optionLocator = frame.getByRole('option', { name: option }).first();
            try {
              await optionLocator.click({ timeout: 2500 });
            } catch {
              await frame.getByText(option, { exact: false }).last().click({ timeout: 2500 });
            }
            how = ' (custom dropdown)';
          }
          ActionLog.push({
            type: 'select', selector: entry.candidates[0], candidates: entry.candidates,
            text: option, elementLabel: entry.label, role: entry.role, frameUrl: entry.frameUrl,
            pageUrl: currentMap?.url, description: `select "${option}" in "${entry.label}"`,
          });
          return await afterRefAction(activePage, `Selected "${option}" in [${ref}] "${entry.label}"${how}`);
        });
      } catch (err) {
        return `Error selecting in ref [${ref}]: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/** Hover an element (menus that open on hover). */
export function browserHoverRef(page: Page) {
  return {
    name: 'browser_hover_ref',
    description: 'Move the mouse over an element by its number (opens hover menus/tooltips). Input: the ref number.',
    func: async (input: string): Promise<string> => {
      const args = parseArgs(input);
      const ref = args ? Number(args.ref) : parseInt((input ?? '').trim(), 10);
      if (isNaN(ref)) return 'Error: input must be a ref number.';
      try {
        return await withActivePage(page, async (activePage) => {
          if (!currentMap) return NO_MAP_MSG;
          const resolved = await resolveRef(activePage, ref);
          if (!resolved) return badRef(ref);
          await resolved.frame.hover(resolved.selector, { timeout: 4000 });
          return await afterRefAction(activePage, `Hovered [${ref}] "${resolved.entry.label}"`);
        });
      } catch (err) {
        return `Error hovering ref [${ref}]: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
