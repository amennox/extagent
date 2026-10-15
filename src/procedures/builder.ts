import { normalizeDomain } from '../tracking/domainUtils';
import { sensitiveKind } from './sensitive';
import { newId, Procedure, ProcedureParam, ProcedureSource, ProcedureStep, StepTarget } from './types';

/**
 * An action captured by the recorder (operator) or logged while the agent
 * works (ActionLog). Raw material for procedure steps.
 */
export interface CapturedAction {
  type: 'click' | 'type' | 'navigate' | 'select' | 'check' | 'press' | 'wait';
  selector?: string;
  candidates?: string[];
  text?: string;
  url?: string;
  pageUrl?: string;
  pageTitle?: string;
  elementText?: string;
  elementLabel?: string;
  role?: string;
  frameUrl?: string;
  /** HTML input type (password detection) */
  inputType?: string;
  description?: string;
  thumbnail?: string;
  timestamp?: number;
}

export function slugify(text: string, fallback = 'valore'): string {
  const s = (text ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return s || fallback;
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

function targetOf(a: CapturedAction): StepTarget | undefined {
  const candidates = (a.candidates?.length ? a.candidates : a.selector ? [a.selector] : []).filter(Boolean);
  if (!candidates.length && !a.elementLabel && !a.elementText) return undefined;
  return {
    candidates,
    label: a.elementLabel || undefined,
    text: a.elementText ? a.elementText.slice(0, 120) : undefined,
    role: a.role,
    frameUrl: a.frameUrl,
  };
}

function describe(a: CapturedAction, value?: string): string {
  const what = a.elementLabel || a.elementText || a.selector || '';
  switch (a.type) {
    case 'navigate': return `Apri ${a.url}`;
    case 'click': return `Clicca "${what.slice(0, 60)}"`;
    case 'type': return `Compila "${what.slice(0, 60)}"`;
    case 'select': return `Seleziona "${value ?? ''}" in "${what.slice(0, 60)}"`;
    case 'check': return `${value === 'false' ? 'Deseleziona' : 'Seleziona'} "${what.slice(0, 60)}"`;
    case 'press': return `Premi ${value || 'Enter'}${what ? ` in "${what.slice(0, 60)}"` : ''}`;
    case 'wait': return 'Attendi';
  }
}

/**
 * Build a procedure from captured actions. Sensitive typed values are never
 * kept: they become required parameters (type secret for passwords).
 */
export function buildProcedure(
  actions: CapturedAction[],
  meta: { name: string; description?: string; source: ProcedureSource; startUrl?: string }
): Procedure {
  const params: ProcedureParam[] = [];
  const used = new Set<string>();
  const steps: ProcedureStep[] = [];

  // Merge consecutive fills of the same field (keep the last value)
  const merged: CapturedAction[] = [];
  for (const a of actions) {
    const last = merged[merged.length - 1];
    const sameTarget = last && (last.candidates?.[0] ?? last.selector) === (a.candidates?.[0] ?? a.selector);
    if (a.type === 'type' && last?.type === 'type' && sameTarget) {
      merged[merged.length - 1] = a;
      continue;
    }
    // Duplicate navigations to the same URL (reloads, SPA double events)
    if (a.type === 'navigate' && last?.type === 'navigate' && last.url === a.url) continue;
    merged.push(a);
  }

  const startUrl = meta.startUrl ?? merged.find(a => a.type === 'navigate')?.url ?? merged[0]?.pageUrl;
  if (startUrl && merged[0]?.type !== 'navigate') {
    merged.unshift({ type: 'navigate', url: startUrl, pageUrl: startUrl });
  }

  for (const a of merged) {
    let value: string | undefined;
    switch (a.type) {
      case 'navigate': value = a.url; break;
      case 'press': value = a.text || 'Enter'; break;
      case 'type':
      case 'select':
      case 'check': value = a.text ?? ''; break;
    }
    if (a.type === 'type' && value !== undefined) {
      const kind = sensitiveKind(value, a.elementLabel ?? '', a.inputType ?? '');
      if (kind && !/^\{\{.*\}\}$/.test(value)) {
        const name = uniqueName(slugify(a.elementLabel || kind, kind), used);
        params.push({
          name,
          label: a.elementLabel || kind,
          type: kind === 'password' || kind === 'secret' || kind === 'cvv' ? 'secret' : 'text',
          required: true,
          description: 'Valore sensibile: non viene salvato, va fornito a ogni esecuzione.',
        });
        value = `{{${name}}}`;
      }
    }
    const type = a.type === 'type' ? 'fill' : a.type;
    steps.push({
      id: newId('s_'),
      type,
      description: a.type === 'type' && value?.startsWith('{{') ? `Compila "${(a.elementLabel || '').slice(0, 60)}" con ${value}` : describe(a, value),
      target: a.type === 'navigate' || a.type === 'wait' ? undefined : targetOf(a),
      value,
      approval: 'auto',
      pageUrl: a.pageUrl,
      thumbnail: a.thumbnail,
      timestamp: a.timestamp,
    });
  }

  // Parameters already present as {{x}} in values (e.g. migrated recordings)
  for (const s of steps) {
    for (const m of (s.value ?? '').matchAll(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g)) {
      const name = m[1];
      if (/^(oggi|today|ora|now)$/i.test(name) || used.has(name)) continue;
      used.add(name);
      params.push({ name, type: 'text', required: true });
    }
  }

  const now = Date.now();
  return {
    id: newId('p_'),
    name: meta.name,
    description: meta.description ?? '',
    domain: startUrl ? normalizeDomain(startUrl) : undefined,
    startUrl,
    params,
    steps,
    version: 1,
    createdAt: now,
    updatedAt: now,
    source: meta.source,
    runs: [],
  };
}

export interface ParamSuggestion {
  stepIndex: number;
  value: string;
  name: string;
  label?: string;
}

/** Typed/selected literal values that could become parameters. */
export function suggestParams(proc: Procedure): ParamSuggestion[] {
  const used = new Set(proc.params.map(p => p.name));
  const out: ParamSuggestion[] = [];
  proc.steps.forEach((s, i) => {
    if ((s.type === 'fill' || s.type === 'select') && s.value && !/\{\{/.test(s.value)) {
      const label = s.target?.label || s.target?.text;
      out.push({ stepIndex: i, value: s.value, label, name: uniqueName(slugify(label || `campo_${i + 1}`), used) });
    }
  });
  return out;
}

/** Turn the literal value of a step into a {{parameter}} (default = old value). */
export function makeParam(proc: Procedure, stepIndex: number, name: string, type: ProcedureParam['type'] = 'text'): Procedure {
  const step = proc.steps[stepIndex];
  if (!step) return proc;
  const clean = slugify(name, `param_${stepIndex + 1}`);
  const exists = proc.params.some(p => p.name === clean);
  const old = step.value ?? '';
  const steps = proc.steps.map((s, i) => (i === stepIndex ? { ...s, value: `{{${clean}}}` } : s));
  const params = exists ? proc.params : [...proc.params, {
    name: clean,
    label: step.target?.label || step.target?.text || clean,
    type,
    required: true,
    default: type === 'secret' || /^\{\{/.test(old) ? undefined : old,
  }];
  return { ...proc, steps, params };
}

/** Parameters referenced by steps but not declared (editor validation). */
export function undeclaredParams(proc: Procedure): string[] {
  const declared = new Set(proc.params.map(p => p.name));
  const missing = new Set<string>();
  for (const s of proc.steps) {
    const text = `${s.value ?? ''} ${s.instruction ?? ''}`;
    for (const m of text.matchAll(/\{\{\s*([a-zA-Z_][\w]*)/g)) {
      const name = m[1];
      if (/^(oggi|today|ora|now)$/i.test(name)) continue;
      const producedEarlier = proc.steps.some(x => x.saveAs === name);
      if (!declared.has(name) && !producedEarlier) missing.add(name);
    }
  }
  return [...missing];
}
