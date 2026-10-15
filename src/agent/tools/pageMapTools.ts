import type { Page } from "playwright-crx";
import { ActionLog } from "../../tracking/actionLog";
import { settleAfterAction } from "./stability";
import { truncate, withActivePage } from "./utils";

/**
 * Interactive page map ("set of marks").
 *
 * `browser_interactive_map` scans the page and returns a NUMBERED list of the
 * visible interactive elements only (role, label, current value, state). The
 * ref→locator mapping lives extension-side, so the model acts by reference
 * (`browser_click_ref: 12`) instead of inventing CSS selectors — removing the
 * single most frequent failure cause. After each ref action the map is
 * rescanned and a DIFF of what changed is appended to the tool result, closing
 * the observe→act feedback loop at minimal token cost.
 */

export interface MapEntry {
  ref: number;
  role: string;
  label: string;
  value?: string;
  state?: string;
  candidates: string[];
}

interface PageMap {
  url: string;
  entries: MapEntry[];
  /** Visible non-interactive signals: toasts, validation errors, alerts */
  alerts: string[];
}

// Module-level registry (one agent per window, same pattern as ScreenshotManager)
let currentMap: PageMap | null = null;

export function getMapEntry(ref: number): MapEntry | undefined {
  return currentMap?.entries.find(e => e.ref === ref);
}

/** For tests */
export function _setCurrentMap(map: { url: string; entries: MapEntry[]; alerts?: string[] } | null): void {
  currentMap = map ? { alerts: [], ...map } : null;
}

/** In-page scan: runs inside the page via evaluate. Self-contained. */
function scanInteractiveElements(): { elements: Array<Omit<MapEntry, 'ref'>>; alerts: string[] } {
  const results: Array<Omit<MapEntry, 'ref'>> = [];
  const seen = new Set<Element>();

  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cssEscape = (v: string) =>
    (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(v) : v.replace(/([^a-zA-Z0-9_-])/g, '\\$1');

  const isVisible = (el: Element): boolean => {
    const rect = (el as HTMLElement).getBoundingClientRect?.();
    if (!rect || rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el as HTMLElement);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    // In viewport (with margin: elements slightly below the fold still matter)
    if (rect.bottom < 0 || rect.top > window.innerHeight + 400) return false;
    return true;
  };

  const labelFor = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    if (el.id) {
      const lbl = document.querySelector(`label[for="${esc(el.id)}"]`);
      if (lbl?.textContent?.trim()) return lbl.textContent.trim();
    }
    const wrapping = el.closest('label');
    if (wrapping?.textContent?.trim()) return wrapping.textContent.trim();
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;
    const text = (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? '';
    if (text) return text;
    const title = el.getAttribute('title') ?? el.getAttribute('name') ?? '';
    return title;
  };

  const candidatesFor = (el: Element): string[] => {
    const tag = el.tagName.toLowerCase();
    const cands: string[] = [];
    const name = el.getAttribute('name');
    if (name) cands.push(`${tag}[name="${esc(name)}"]`);
    const aria = el.getAttribute('aria-label');
    if (aria) cands.push(`[aria-label="${esc(aria)}"]`);
    if (el.id) cands.push(`#${cssEscape(el.id)}`);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) cands.push(`${tag}[placeholder="${esc(placeholder)}"]`);
    const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test');
    if (testId) cands.push(`[data-testid="${esc(testId)}"]`);
    // CSS path fallback
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
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') return type;
      return 'textbox';
    }
    return tag;
  };

  // NOTE: role="option"/listbox items are essential for custom dropdowns
  // (Radix/shadcn/MUI render options as divs in portals, not <option>).
  const selector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="combobox"], [role="option"], [onclick], [contenteditable="true"]';
  const nodes = Array.from(document.querySelectorAll(selector));

  for (const el of nodes) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isVisible(el)) continue;
    if (el instanceof HTMLInputElement && el.type === 'hidden') continue;

    const role = roleFor(el);
    const label = labelFor(el).replace(/\s+/g, ' ').slice(0, 80);
    if (!label && role !== 'textbox' && role !== 'select') continue; // unlabeled non-inputs are noise

    let value: string | undefined;
    let state: string | undefined;
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') state = el.checked ? 'checked' : 'unchecked';
      else if (el.type !== 'password') value = el.value?.slice(0, 40) || undefined;
      else value = el.value ? '•••' : undefined;
    } else if (el instanceof HTMLTextAreaElement) {
      value = el.value?.slice(0, 40) || undefined;
    } else if (el instanceof HTMLSelectElement) {
      value = el.selectedOptions?.[0]?.textContent?.trim().slice(0, 40) || undefined;
    }
    if ((el as HTMLButtonElement).disabled) state = state ? `${state},disabled` : 'disabled';

    // aria-invalid fields carry a validation error — surface it in the state
    if (el.getAttribute('aria-invalid') === 'true') {
      state = state ? `${state},invalid` : 'invalid';
    }

    results.push({ role, label, value, state, candidates: candidatesFor(el) });
    if (results.length >= 150) break; // hard cap
  }

  // Non-interactive signals the agent MUST see: toasts, validation errors,
  // alert banners. Without these, a failed save looks like "no changes".
  const alerts: string[] = [];
  const alertSelector = '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"], .Toastify__toast, [class*="toast"], [class*="Toast"], [class*="snackbar"], [class*="alert-"], .invalid-feedback, .error-message, [class*="error-message"], [id$="-form-item-message"]';
  for (const el of Array.from(document.querySelectorAll(alertSelector))) {
    if (!isVisible(el)) continue;
    const text = (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim();
    if (text && text.length > 1 && !alerts.includes(text)) {
      alerts.push(text.slice(0, 200));
      if (alerts.length >= 6) break;
    }
  }

  return { elements: results, alerts };
}

async function buildMap(page: Page): Promise<PageMap> {
  const raw = (await page.evaluate(scanInteractiveElements)) as { elements: Array<Omit<MapEntry, 'ref'>>; alerts: string[] };
  const entries: MapEntry[] = raw.elements.map((e, i) => ({ ...e, ref: i + 1 }));
  const url = page.url();
  return { url, entries, alerts: raw.alerts ?? [] };
}

export function formatEntry(e: MapEntry): string {
  const value = e.value !== undefined ? ` = "${e.value}"` : '';
  const state = e.state ? ` (${e.state})` : '';
  return `[${e.ref}] ${e.role} "${e.label}"${value}${state}`;
}

export function formatMap(entries: MapEntry[]): string {
  if (entries.length === 0) return 'No interactive elements visible.';
  return entries.map(formatEntry).join('\n');
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
  for (const e of added.slice(0, 8)) lines.push(`+ ${formatEntry(e)}`);
  if (added.length > 8) lines.push(`+ …and ${added.length - 8} more new elements`);
  for (const e of removed.slice(0, 5)) lines.push(`- [${e.ref}] ${e.role} "${e.label}"`);
  if (removed.length > 5) lines.push(`- …and ${removed.length - 5} more removed`);
  for (const e of valueChanged.slice(0, 5)) lines.push(`~ ${formatEntry(e)}`);
  return lines.join('\n');
}

async function resolveRef(page: Page, ref: number, timeoutMs = 4000): Promise<{ selector: string; entry: MapEntry } | null> {
  const entry = getMapEntry(ref);
  if (!entry) return null;
  for (const selector of entry.candidates) {
    try {
      const el = await page.waitForSelector(selector, { timeout: Math.max(500, timeoutMs / entry.candidates.length), state: 'visible' });
      if (el) return { selector, entry };
    } catch { /* next candidate */ }
  }
  return null;
}

/** Shared post-action epilogue: settle + rescan + diff (elements AND page messages). */
async function afterRefAction(page: Page, actionDetail: string): Promise<string> {
  const settle = await settleAfterAction(page);
  let diffText = '';
  let alertText = '';
  try {
    const beforeEntries = currentMap?.entries ?? [];
    const beforeAlerts = currentMap?.alerts ?? [];
    const fresh = await buildMap(page);
    diffText = diffMaps(beforeEntries, fresh.entries);
    const newAlerts = diffAlerts(beforeAlerts, fresh.alerts);
    if (newAlerts.length > 0) {
      alertText = `\n⚠ PAGE MESSAGES:\n${newAlerts.map(a => `! ${a}`).join('\n')}`;
    }
    currentMap = fresh; // refs stay valid for the *new* state
  } catch {
    diffText = 'diff unavailable';
  }
  return `${actionDetail} · ${settle}\nChanges:\n${diffText}${alertText}`;
}

const NO_MAP_MSG = 'Error: no interactive map. Call browser_interactive_map first.';
const badRef = (ref: number) => `Error: ref [${ref}] not found in the current map. Call browser_interactive_map to refresh.`;

export function browserInteractiveMap(page: Page) {
  return {
    name: 'browser_interactive_map',
    description: 'Scan the page and return a numbered list of visible interactive elements (buttons, links, fields). Act on them with browser_click_ref / browser_fill_ref / browser_select_ref using the number.',
    func: async (): Promise<string> => {
      try {
        return await withActivePage(page, async (activePage) => {
          const map = await buildMap(activePage);
          currentMap = map;
          const alertsBlock = map.alerts.length
            ? `\n\n⚠ PAGE MESSAGES:\n${map.alerts.map(a => `! ${a}`).join('\n')}`
            : '';
          return truncate(`Interactive elements on ${map.url}:\n${formatMap(map.entries)}${alertsBlock}`);
        });
      } catch (err) {
        return `Error building interactive map: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

export function browserClickRef(page: Page) {
  return {
    name: 'browser_click_ref',
    description: 'Click an element by its number from browser_interactive_map. Input: the ref number (e.g. 12).',
    func: async (input: string): Promise<string> => {
      const ref = parseInt(input.trim(), 10);
      if (isNaN(ref)) return 'Error: input must be a ref number from browser_interactive_map.';
      try {
        return await withActivePage(page, async (activePage) => {
          if (!currentMap) return NO_MAP_MSG;
          const resolved = await resolveRef(activePage, ref);
          if (!resolved) return badRef(ref);
          await activePage.click(resolved.selector, { timeout: 4000 });
          ActionLog.push({
            type: 'click', selector: resolved.selector, candidates: resolved.entry.candidates,
            elementText: resolved.entry.label, description: `click "${resolved.entry.label}"`,
          });
          return await afterRefAction(activePage, `Clicked [${ref}] ${resolved.entry.role} "${resolved.entry.label}"`);
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
    description: 'Fill a field by its number from browser_interactive_map. Input: "ref|text" (e.g. 7|Rossi SRL).',
    func: async (input: string): Promise<string> => {
      const sep = input.indexOf('|');
      const ref = parseInt(input.slice(0, sep >= 0 ? sep : undefined).trim(), 10);
      const text = sep >= 0 ? input.slice(sep + 1) : '';
      if (isNaN(ref) || sep < 0) return 'Error: input must be "ref|text".';
      try {
        return await withActivePage(page, async (activePage) => {
          if (!currentMap) return NO_MAP_MSG;
          const resolved = await resolveRef(activePage, ref);
          if (!resolved) return badRef(ref);
          // fill() dispatches proper input events — works with React/Vue controlled inputs
          await activePage.fill(resolved.selector, text, { timeout: 4000 });
          ActionLog.push({
            type: 'type', selector: resolved.selector, candidates: resolved.entry.candidates,
            text, elementLabel: resolved.entry.label, description: `type in "${resolved.entry.label}"`,
          });
          return await afterRefAction(activePage, `Filled [${ref}] "${resolved.entry.label}" with "${text}"`);
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
    description: 'Select an option in a dropdown by its number from browser_interactive_map. Input: "ref|option label or value".',
    func: async (input: string): Promise<string> => {
      const sep = input.indexOf('|');
      const ref = parseInt(input.slice(0, sep >= 0 ? sep : undefined).trim(), 10);
      const option = sep >= 0 ? input.slice(sep + 1).trim() : '';
      if (isNaN(ref) || sep < 0) return 'Error: input must be "ref|option".';
      try {
        return await withActivePage(page, async (activePage) => {
          if (!currentMap) return NO_MAP_MSG;
          const resolved = await resolveRef(activePage, ref);
          if (!resolved) return badRef(ref);
          try {
            await activePage.selectOption(resolved.selector, { label: option });
          } catch {
            await activePage.selectOption(resolved.selector, { value: option });
          }
          ActionLog.push({
            type: 'select', selector: resolved.selector, candidates: resolved.entry.candidates,
            text: option, elementLabel: resolved.entry.label, description: `select "${option}" in "${resolved.entry.label}"`,
          });
          return await afterRefAction(activePage, `Selected "${option}" in [${ref}] "${resolved.entry.label}"`);
        });
      } catch (err) {
        return `Error selecting in ref [${ref}]: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
