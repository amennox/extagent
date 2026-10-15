/**
 * Recording content script — injected ON DEMAND (chrome.scripting, all frames)
 * only while the operator records a procedure. It starts capturing as soon as
 * it is injected and stops on "stopRecordingCapture".
 *
 * Self-contained on purpose: it is built as a classic script, so it must not
 * import shared modules.
 *
 * Captures: clicks (real target through open shadow roots), field edits
 * (recorded once when the field loses focus), selects, checkboxes,
 * Enter/Escape. Password values are never sent.
 */

interface CapturedTarget {
  candidates: string[];
  label?: string;
  text?: string;
  role?: string;
  inputType?: string;
  rect?: { x: number; y: number; width: number; height: number };
  dpr: number;
}

declare global {
  interface Window { __dommotionRecorder?: { stop: () => void } }
}

(() => {
  if (window.__dommotionRecorder) return;

  const isTop = window === window.top;
  let banner: HTMLElement | null = null;

  const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cssEscape = (v: string) =>
    (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(v) : v.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  const textOf = (el: Element | null) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const INTERACTIVE = 'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="tab"], [role="option"], [role="combobox"], [role="treeitem"], [onclick], [contenteditable="true"]';

  /** Real event target, through open shadow roots, lifted to the interactive ancestor. */
  function realTarget(e: Event): Element | null {
    const path = e.composedPath?.() ?? [];
    const first = (path[0] as Element) ?? (e.target as Element);
    if (!(first instanceof Element)) return null;
    for (const node of path) {
      if (node instanceof Element && node.matches(INTERACTIVE)) return node;
      if (node === document.body) break;
    }
    return first;
  }

  function labelFor(el: Element): string | undefined {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map(id => textOf(document.getElementById(id))).filter(Boolean).join(' ');
      if (t) return t;
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length && textOf(labels[0])) return textOf(labels[0]).slice(0, 120);
    const wrap = el.closest('label');
    if (wrap && textOf(wrap)) return textOf(wrap).slice(0, 120);
    const ph = el.getAttribute('placeholder');
    if (ph) return ph;
    return el.getAttribute('title') ?? el.getAttribute('name') ?? undefined;
  }

  function roleFor(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el as HTMLInputElement).type;
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'textbox';
    }
    return tag;
  }

  function cssPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
      if (cur.id && !/\d{3,}/.test(cur.id)) { parts.unshift(`#${cssEscape(cur.id)}`); break; }
      let part = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(s => s.tagName === cur!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function describeTarget(el: Element): CapturedTarget {
    const tag = el.tagName.toLowerCase();
    const candidates: string[] = [];
    const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-cy');
    if (testId) candidates.push(`[data-testid="${esc(testId)}"]`);
    const name = el.getAttribute('name');
    if (name) candidates.push(`${tag}[name="${esc(name)}"]`);
    if (el.id && !/\d{3,}|^[a-f0-9-]{16,}$/i.test(el.id)) candidates.push(`#${cssEscape(el.id)}`);
    const aria = el.getAttribute('aria-label');
    if (aria) candidates.push(`${tag}[aria-label="${esc(aria)}"]`);
    const ph = el.getAttribute('placeholder');
    if (ph) candidates.push(`${tag}[placeholder="${esc(ph)}"]`);
    const path = cssPath(el);
    if (path && !candidates.includes(path)) candidates.push(path);
    const r = (el as HTMLElement).getBoundingClientRect();
    const isField = /^(input|textarea|select)$/.test(tag);
    return {
      candidates,
      label: labelFor(el),
      text: isField ? undefined : textOf(el).slice(0, 120) || undefined,
      role: roleFor(el),
      inputType: el instanceof HTMLInputElement ? el.type : undefined,
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      dpr: window.devicePixelRatio || 1,
    };
  }

  function send(type: string, el: Element, extra: Record<string, unknown> = {}): void {
    const t = describeTarget(el);
    const description = extra.description as string | undefined;
    try {
      chrome.runtime.sendMessage({
        action: 'recordingStep',
        step: {
          type,
          candidates: t.candidates,
          selector: t.candidates[0],
          elementLabel: t.label,
          elementText: t.text,
          role: t.role,
          inputType: t.inputType,
          pageUrl: location.href,
          pageTitle: document.title,
          timestamp: Date.now(),
          ...extra,
          description,
        },
        rect: isTop ? t.rect : undefined,
        dpr: t.dpr,
      });
    } catch {
      // extension reloaded — ignore
    }
  }

  const isTextField = (el: Element) =>
    (el instanceof HTMLInputElement && !['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image', 'range', 'color'].includes(el.type)) ||
    el instanceof HTMLTextAreaElement ||
    (el as HTMLElement).isContentEditable;

  function onClick(e: MouseEvent): void {
    const el = realTarget(e);
    if (!el || banner?.contains(el)) return;
    // Captured by the change handler instead
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return;
    if (el instanceof HTMLSelectElement || isTextField(el)) return;
    if (el.tagName === 'LABEL') {
      const control = (el as HTMLLabelElement).control;
      if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) return;
      if (control && isTextField(control)) return;
    }
    send('click', el);
  }

  // `change` does not cross shadow boundaries; `input` and `focusout` do.
  // Text fields are marked dirty on input and recorded once on focusout/Enter.
  const dirty = new Set<Element>();

  function flushField(el: Element): void {
    if (!dirty.has(el)) return;
    dirty.delete(el);
    if ((el as HTMLElement).isContentEditable) {
      send('type', el, { text: textOf(el) });
      return;
    }
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    const isPassword = field instanceof HTMLInputElement && field.type === 'password';
    // Never send password values: the step becomes a {{password}} parameter
    send('type', el, { text: isPassword ? '' : field.value });
  }

  function onInput(e: Event): void {
    const path = e.composedPath?.() ?? [];
    const el = (path[0] as Element) ?? (e.target as Element);
    if (!(el instanceof Element)) return;
    if (el instanceof HTMLSelectElement) {
      const option = el.selectedOptions?.[0]?.textContent?.trim() ?? el.value;
      send('select', el, { text: option });
      return;
    }
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      send('check', el, { text: el.checked ? 'true' : 'false' });
      return;
    }
    if (isTextField(el)) dirty.add(el);
  }

  function onFocusOut(e: FocusEvent): void {
    const path = e.composedPath?.() ?? [];
    const el = (path[0] as Element) ?? (e.target as Element);
    if (el instanceof Element) flushField(el);
  }

  function flushAll(): void {
    for (const el of Array.from(dirty)) flushField(el);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    const el = realTarget(e);
    if (!el) return;
    if (e.key === 'Enter' && el instanceof HTMLTextAreaElement) return; // newline
    // Enter submits before the field loses focus: flush its value first
    const path = e.composedPath?.() ?? [];
    const field = path[0] instanceof Element ? path[0] : el;
    if (e.key === 'Enter') flushField(field);
    send('press', field, { text: e.key });
  }

  function showBanner(): void {
    if (!isTop || banner) return;
    banner = document.createElement('div');
    banner.setAttribute('data-dommotion-recording', 'true');
    banner.textContent = '● REC DomMotion';
    Object.assign(banner.style, {
      position: 'fixed', top: '8px', right: '8px', zIndex: '2147483647',
      background: 'rgba(220, 38, 38, 0.92)', color: '#fff', font: '600 11px/1 system-ui, sans-serif',
      padding: '6px 10px', borderRadius: '6px', pointerEvents: 'none', boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
    } as Partial<CSSStyleDeclaration>);
    document.documentElement.appendChild(banner);
  }

  function stop(): void {
    flushAll();
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('focusout', onFocusOut, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('pagehide', flushAll, true);
    banner?.remove();
    banner = null;
    delete window.__dommotionRecorder;
  }

  document.addEventListener('click', onClick, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('pagehide', flushAll, true);
  showBanner();
  window.__dommotionRecorder = { stop };

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === 'stopRecordingCapture') stop();
  });
})();

export {};
