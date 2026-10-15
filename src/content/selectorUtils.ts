/**
 * Escape a value for use inside a quoted CSS attribute selector.
 */
function escapeAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Escape an identifier (e.g. an id) for use in a CSS selector.
 * Uses CSS.escape when available (browser), with a conservative fallback.
 */
function escapeIdent(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}

/**
 * Build a robust CSS selector for a DOM element.
 * Priority: name attribute → aria-label → id → CSS path.
 */
export function getSelector(el: Element): string {
  const name = el.getAttribute('name');
  if (name) return `[name="${escapeAttrValue(name)}"]`;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `[aria-label="${escapeAttrValue(ariaLabel)}"]`;

  if (el.id) return `#${escapeIdent(el.id)}`;

  // CSS path fallback: walk up the tree
  const parts: string[] = [];
  let current: Element | null = el;
  while (current) {
    if (current.id) {
      parts.unshift(`#${escapeIdent(current.id)}`);
      break;
    }
    let part = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (s: Element) => s.tagName === current!.tagName
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(part);
    current = parent;
    if (!current || current.tagName === 'HTML' || current.tagName === 'BODY') break;
  }
  return parts.join(' > ');
}

/**
 * Build a bundle of alternative locators for an element, from most to least
 * robust. The replay engine tries them in order (self-healing).
 */
export interface LocatorBundle {
  /** Primary CSS selector (same as getSelector) */
  css: string;
  /** All candidate selectors in priority order */
  candidates: string[];
  /** Visible text of the element (for text-based fallback matching) */
  text?: string;
  /** Associated label text, for form fields */
  label?: string;
  /** Tag name, lowercase */
  tag: string;
}

function findLabelText(el: Element): string | undefined {
  // <label for="id">
  if (el.id) {
    const doc = el.ownerDocument;
    const label = doc.querySelector(`label[for="${escapeAttrValue(el.id)}"]`);
    const txt = label?.textContent?.trim();
    if (txt) return txt;
  }
  // Wrapping <label>
  const wrapping = el.closest('label');
  const txt = wrapping?.textContent?.trim();
  if (txt) return txt.slice(0, 120);
  return undefined;
}

export function getLocatorBundle(el: Element): LocatorBundle {
  const candidates: string[] = [];
  const tag = el.tagName.toLowerCase();

  const name = el.getAttribute('name');
  if (name) candidates.push(`${tag}[name="${escapeAttrValue(name)}"]`);

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) candidates.push(`[aria-label="${escapeAttrValue(ariaLabel)}"]`);

  if (el.id) candidates.push(`#${escapeIdent(el.id)}`);

  const placeholder = el.getAttribute('placeholder');
  if (placeholder) candidates.push(`${tag}[placeholder="${escapeAttrValue(placeholder)}"]`);

  // CSS path always last (least stable)
  const cssPath = getSelector(el);
  if (!candidates.includes(cssPath)) candidates.push(cssPath);

  const text = (el.textContent ?? '').trim().slice(0, 120) || undefined;

  return {
    css: candidates[0],
    candidates,
    text,
    label: findLabelText(el),
    tag,
  };
}
