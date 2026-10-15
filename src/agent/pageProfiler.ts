import type { Page } from 'playwright-crx';

/**
 * Page profiler — detects how a site is built (framework, routing, UI kit,
 * hostile structures) so the agent can pick the right interaction strategy
 * instead of treating a 2010 server-rendered form and a React wizard the same.
 * One in-page scan at attach time (~50ms), result cached per task.
 */

export interface PageProfile {
  framework: 'react' | 'angular' | 'vue' | 'jquery' | 'server-rendered' | 'unknown';
  spa: boolean;
  uiKits: string[];
  iframes: number;
  shadowDom: boolean;
  customFormControls: boolean;
  virtualScroll: boolean;
}

/** Raw signals collected in-page (kept flat/serializable). */
export interface PageSignals {
  hasReactHook: boolean;
  hasReactAttrs: boolean;
  ngVersion: boolean;
  hasVue: boolean;
  hasJquery: boolean;
  historyApiSpa: boolean;
  classSample: string;
  iframes: number;
  shadowRoots: number;
  divRoleButtons: number;
  nativeButtons: number;
  virtualScrollHints: boolean;
}

function collectSignals(): PageSignals {
  const w = window as any;
  const doc = document;

  let shadowRoots = 0;
  const all = doc.querySelectorAll('*');
  const limit = Math.min(all.length, 3000);
  for (let i = 0; i < limit; i++) {
    if ((all[i] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) shadowRoots++;
  }

  let classSample = Array.from(doc.querySelectorAll('body *'))
    .slice(0, 400)
    .map(el => el.className && typeof el.className === 'string' ? el.className : '')
    .join(' ')
    .slice(0, 4000);
  // Radix/shadcn signature: data-state/data-radix-* attributes on interactive elements
  if (doc.querySelector('[data-radix-popper-content-wrapper], [data-radix-collection-item]') ||
      doc.querySelectorAll('[data-state]').length >= 3) {
    classSample += ' __radix-shadcn__';
  }

  // Robust React detection: React 16+ attaches __reactFiber$/__reactProps$
  // keys to DOM nodes (works without devtools, unlike the global hook).
  let reactFiberFound = false;
  const sample = doc.querySelectorAll('body, body *');
  const sampleLimit = Math.min(sample.length, 300);
  for (let i = 0; i < sampleLimit && !reactFiberFound; i++) {
    const keys = Object.keys(sample[i] as any);
    for (const k of keys) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactProps$') || k.startsWith('__reactContainer$')) {
        reactFiberFound = true;
        break;
      }
    }
  }

  return {
    hasReactHook: reactFiberFound
      || !!w.__REACT_DEVTOOLS_GLOBAL_HOOK__
      || !!doc.querySelector('[data-reactroot], [data-react-checksum], #__next, #__nuxt'),
    hasReactAttrs: !!doc.querySelector('[id="root"] > *, [id="app"] > *') && classSample.includes('css-'),
    ngVersion: !!doc.querySelector('[ng-version]'),
    hasVue: !!w.__VUE__ || !!doc.querySelector('[data-v-app]') || !!w.Vue,
    hasJquery: !!w.jQuery || !!w.$?.fn?.jquery,
    historyApiSpa: !!(w.__spaDetected || doc.querySelector('router-outlet, [data-reactroot], #root, #app, [id="__next"], [id="__nuxt"]')),
    classSample,
    iframes: doc.querySelectorAll('iframe').length,
    shadowRoots,
    divRoleButtons: doc.querySelectorAll('div[role="button"], span[role="button"], div[role="combobox"]').length,
    nativeButtons: doc.querySelectorAll('button, input[type="submit"], input[type="button"]').length,
    virtualScrollHints: !!doc.querySelector('[class*="virtual"], [class*="ReactVirtualized"], cdk-virtual-scroll-viewport, [data-virtuoso-scroller]'),
  };
}

const UI_KIT_PATTERNS: Array<[string, RegExp]> = [
  ['select2', /select2/],
  ['choices.js', /choices__/],
  ['MUI', /Mui[A-Z]|css-\w+-Mui/],
  ['Radix/shadcn', /__radix-shadcn__/],
  ['Ant Design', /\bant-(btn|input|select|table|form)/],
  ['Bootstrap', /\b(btn btn-|form-control|input-group)/],
  ['Element UI', /\bel-(button|input|select|table)/],
  ['PrimeNG/PrimeReact', /\bp-(button|inputtext|dropdown|datatable)/],
];

/** Classify raw signals into a PageProfile (pure, testable). */
export function classifySignals(s: PageSignals): PageProfile {
  let framework: PageProfile['framework'] = 'unknown';
  if (s.hasReactHook || s.hasReactAttrs) framework = 'react';
  else if (s.ngVersion) framework = 'angular';
  else if (s.hasVue) framework = 'vue';
  else if (s.hasJquery) framework = 'jquery';
  else framework = 'server-rendered';

  const uiKits = UI_KIT_PATTERNS.filter(([, re]) => re.test(s.classSample)).map(([name]) => name);

  const spa = (framework === 'react' || framework === 'angular' || framework === 'vue') && s.historyApiSpa;

  return {
    framework,
    spa,
    uiKits,
    iframes: s.iframes,
    shadowDom: s.shadowRoots > 0,
    customFormControls: s.divRoleButtons > Math.max(2, s.nativeButtons / 2),
    virtualScroll: s.virtualScrollHints,
  };
}

export async function profilePage(page: Page): Promise<PageProfile | null> {
  try {
    const signals = (await page.evaluate(collectSignals)) as PageSignals;
    return classifySignals(signals);
  } catch {
    return null;
  }
}

/** Short human-readable summary, e.g. "React SPA · MUI · 1 iframe". */
export function profileSummary(p: PageProfile): string {
  const parts: string[] = [];
  parts.push(p.framework === 'server-rendered' ? 'server-rendered' : `${p.framework}${p.spa ? ' SPA' : ''}`);
  if (p.uiKits.length) parts.push(p.uiKits.join(', '));
  if (p.iframes > 0) parts.push(`${p.iframes} iframe`);
  if (p.shadowDom) parts.push('shadow DOM');
  if (p.virtualScroll) parts.push('virtual scroll');
  return parts.join(' · ');
}

/**
 * Interaction playbook injected into the system prompt: few targeted lines,
 * hints not hard rules.
 */
export function playbookFor(p: PageProfile, lang: 'it' | 'en'): string {
  const it = lang === 'it';
  const lines: string[] = [];
  lines.push(it
    ? `Struttura rilevata: ${profileSummary(p)}.`
    : `Detected structure: ${profileSummary(p)}.`);

  if (p.spa) {
    lines.push(it
      ? '- SPA: dopo click di navigazione NON usare browser_wait_for_navigation; la pagina si aggiorna senza reload (i tool attendono già la stabilità).'
      : '- SPA: after navigation clicks do NOT use browser_wait_for_navigation; the page updates without a reload (tools already wait for stability).');
  }
  if (p.framework === 'react' || p.framework === 'vue') {
    lines.push(it
      ? '- Input controllati: usa browser_fill_ref / browser_type (generano eventi nativi). Non impostare valori in altro modo.'
      : '- Controlled inputs: use browser_fill_ref / browser_type (they dispatch native events). Do not set values any other way.');
  }
  if (p.customFormControls || p.uiKits.some(k => /select2|choices|MUI|Ant|Element|Prime|Radix/i.test(k))) {
    lines.push(it
      ? '- Dropdown custom (non <select>): browser_click_ref per aprire → le opzioni compaiono nei "Changes" come [n] option → browser_click_ref sull\'opzione. MAI browser_select_ref (solo <select> nativi), MAI digitare alla cieca.'
      : '- Custom dropdowns (not native <select>): browser_click_ref to open → the options appear in "Changes" as [n] option → browser_click_ref the option. NEVER browser_select_ref (native <select> only), never type blindly.');
  }
  if (p.iframes > 0) {
    lines.push(it
      ? `- La pagina contiene ${p.iframes} iframe: se un elemento atteso non compare nella mappa, il contenuto può essere dentro un iframe.`
      : `- The page contains ${p.iframes} iframe(s): if an expected element is missing from the map, the content may live inside an iframe.`);
  }
  if (p.virtualScroll) {
    lines.push(it
      ? '- Tabelle con virtual scrolling: estrai in modo incrementale scrollando, un unico snapshot non vede tutte le righe.'
      : '- Virtual-scrolled tables: extract incrementally while scrolling; a single snapshot cannot see all rows.');
  }
  return lines.join('\n');
}
