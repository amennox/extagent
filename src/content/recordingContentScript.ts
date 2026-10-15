import { getLocatorBundle } from './selectorUtils';

let isCapturing = false;
let banner: HTMLElement | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPasswordField(el: Element): boolean {
  return el instanceof HTMLInputElement && el.type === 'password';
}

/** Short snippet of the surrounding content (closest form/section/fieldset). */
function getContextSnippet(el: Element): string | undefined {
  const container = el.closest('form, fieldset, section, [role="dialog"], table');
  const text = container?.textContent?.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 300) : undefined;
}

function baseStep(el: Element) {
  const bundle = getLocatorBundle(el);
  return {
    selector: bundle.css,
    candidates: bundle.candidates,
    elementText: bundle.text,
    elementLabel: bundle.label,
    pageUrl: location.href,
    pageTitle: document.title,
    context: getContextSnippet(el),
    timestamp: Date.now(),
  };
}

function sendStep(step: Record<string, unknown>): void {
  try {
    chrome.runtime.sendMessage({ action: 'recordingStep', step });
  } catch {
    // extension context may be gone (reload) — ignore
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

function handleClick(e: MouseEvent): void {
  if (!isCapturing) return;
  const el = e.target as Element;
  if (!el || banner?.contains(el)) return;

  // Checkbox/radio clicks are captured by the change handler as 'check'
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return;

  const base = baseStep(el);
  const label = base.elementLabel || base.elementText || base.selector;
  sendStep({
    type: 'click',
    ...base,
    description: `click su "${(label ?? '').slice(0, 50)}"`,
  });
}

function handleBlur(e: FocusEvent): void {
  if (!isCapturing) return;
  const el = e.target as HTMLInputElement | HTMLTextAreaElement;
  if (!el || !('value' in el)) return;
  if (el instanceof HTMLSelectElement) return; // handled by change
  // Never record password fields
  if (isPasswordField(el)) return;
  const value = (el as HTMLInputElement).value;
  if (!value) return;

  const base = baseStep(el);
  sendStep({
    type: 'type',
    ...base,
    text: value,
    description: `testo "${value.slice(0, 40)}" in ${base.elementLabel ?? base.selector}`,
  });
}

function handleChange(e: Event): void {
  if (!isCapturing) return;
  const el = e.target as Element;
  if (!el) return;

  if (el instanceof HTMLSelectElement) {
    const base = baseStep(el);
    const selectedText = el.selectedOptions?.[0]?.textContent?.trim() ?? el.value;
    sendStep({
      type: 'select',
      ...base,
      text: el.value,
      elementText: selectedText,
      description: `selezionato "${selectedText}" in ${base.elementLabel ?? base.selector}`,
    });
    return;
  }

  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const base = baseStep(el);
    sendStep({
      type: 'check',
      ...base,
      text: el.checked ? 'true' : 'false',
      description: `${el.checked ? 'spuntato' : 'deselezionato'} ${base.elementLabel ?? base.selector}`,
    });
  }
}

function handleKeydown(e: KeyboardEvent): void {
  if (!isCapturing) return;
  if (e.key !== 'Enter') return;
  const el = e.target as Element;
  if (!el || isPasswordField(el)) return;

  // Flush the current field value first (Enter often submits before blur fires)
  if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value) {
    const base = baseStep(el);
    sendStep({
      type: 'type',
      ...base,
      text: el.value,
      description: `testo "${el.value.slice(0, 40)}" in ${base.elementLabel ?? base.selector}`,
    });
  }
  const base = baseStep(el);
  sendStep({
    type: 'press',
    ...base,
    text: 'Enter',
    description: `premuto Invio in ${base.elementLabel ?? base.selector}`,
  });
}

// ── Recording indicator (transparency for the operator) ──────────────────────

function showBanner(): void {
  if (banner) return;
  banner = document.createElement('div');
  banner.setAttribute('data-dommotion-recording', 'true');
  banner.textContent = '● REC DomMotion';
  Object.assign(banner.style, {
    position: 'fixed',
    top: '8px',
    right: '8px',
    zIndex: '2147483647',
    background: 'rgba(220, 38, 38, 0.92)',
    color: '#fff',
    font: '600 11px/1 system-ui, sans-serif',
    padding: '6px 10px',
    borderRadius: '6px',
    pointerEvents: 'none',
    boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
  } as CSSStyleDeclaration);
  document.documentElement.appendChild(banner);
}

function hideBanner(): void {
  banner?.remove();
  banner = null;
}

// ── Capture lifecycle ─────────────────────────────────────────────────────────

function startCapture(): void {
  if (isCapturing) return;
  isCapturing = true;
  document.addEventListener('click', handleClick, true);
  document.addEventListener('blur', handleBlur, true);
  document.addEventListener('change', handleChange, true);
  document.addEventListener('keydown', handleKeydown, true);
  showBanner();
}

function stopCapture(): void {
  isCapturing = false;
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('blur', handleBlur, true);
  document.removeEventListener('change', handleChange, true);
  document.removeEventListener('keydown', handleKeydown, true);
  hideBanner();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'startRecordingCapture') startCapture();
  if (message.action === 'stopRecordingCapture') stopCapture();
});

// If the page loads while a recording is active (navigation during REC),
// resume capturing automatically.
try {
  chrome.storage.local.get('activeRecording', (result) => {
    if (result?.activeRecording) startCapture();
  });
} catch {
  // storage unavailable — ignore
}
