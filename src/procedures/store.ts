import { normalizeDomain } from '../tracking/domainUtils';
import { newId, Procedure, ProcedureRun, ProcedureStep, STEP_TYPES } from './types';

const STORAGE_KEY = 'procedures';
const MAX_RUNS = 20;
export const PROCEDURE_FILE_FORMAT = 'dommotion-procedure@1';

/**
 * Persistence for procedures (chrome.storage.local, "unlimitedStorage"
 * because step thumbnails are kept with the steps).
 */
export class ProcedureStore {
  private static instance: ProcedureStore | null = null;

  static getInstance(): ProcedureStore {
    if (!ProcedureStore.instance) ProcedureStore.instance = new ProcedureStore();
    return ProcedureStore.instance;
  }

  private async loadAll(): Promise<Record<string, Procedure>> {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return (result?.[STORAGE_KEY] as Record<string, Procedure>) ?? {};
  }

  private async saveAll(all: Record<string, Procedure>): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
  }

  async list(): Promise<Procedure[]> {
    return Object.values(await this.loadAll()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Procedure | null> {
    return (await this.loadAll())[id] ?? null;
  }

  /** Lookup by id or name: exact, case-insensitive, then unique partial match. */
  async findByName(nameOrId: string): Promise<Procedure | null> {
    const all = await this.loadAll();
    if (all[nameOrId]) return all[nameOrId];
    const list = Object.values(all);
    const q = nameOrId.trim().toLowerCase();
    const exact = list.find(p => p.name.trim().toLowerCase() === q);
    if (exact) return exact;
    const partial = list.filter(p => p.name.toLowerCase().includes(q) || q.includes(p.name.toLowerCase()));
    return partial.length === 1 ? partial[0] : null;
  }

  async listForDomain(urlOrDomain: string): Promise<Procedure[]> {
    const domain = normalizeDomain(urlOrDomain);
    if (!domain) return [];
    return (await this.list()).filter(p => p.domain && (p.domain === domain || domain.endsWith(`.${p.domain}`)));
  }

  /** Create or update. Returns the saved procedure. */
  async save(input: Procedure): Promise<Procedure> {
    const all = await this.loadAll();
    const prev = all[input.id];
    const now = Date.now();
    const proc: Procedure = {
      ...input,
      domain: input.domain ? normalizeDomain(input.domain) : (input.startUrl ? normalizeDomain(input.startUrl) : input.domain),
      version: prev ? (prev.version ?? 1) + 1 : (input.version || 1),
      createdAt: prev?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
      runs: input.runs ?? prev?.runs ?? [],
    };
    all[proc.id] = proc;
    await this.saveAll(all);
    return proc;
  }

  async delete(id: string): Promise<void> {
    const all = await this.loadAll();
    delete all[id];
    await this.saveAll(all);
  }

  async duplicate(id: string): Promise<Procedure | null> {
    const src = await this.get(id);
    if (!src) return null;
    const copy: Procedure = {
      ...structuredCloneSafe(src),
      id: newId('p_'),
      name: `${src.name} (copia)`,
      runs: [],
      version: 1,
    };
    return this.save(copy);
  }

  async recordRun(id: string, run: ProcedureRun): Promise<void> {
    const all = await this.loadAll();
    const proc = all[id];
    if (!proc) return;
    proc.runs = [run, ...(proc.runs ?? [])].slice(0, MAX_RUNS);
    await this.saveAll(all);
  }

  // ── Import / export ──────────────────────────────────────────────────────

  exportJson(procs: Procedure[], includeThumbnails = true): string {
    const items = procs.map(p => ({
      ...p,
      runs: [],
      steps: p.steps.map(s => (includeThumbnails ? s : { ...s, thumbnail: undefined })),
    }));
    return JSON.stringify({ format: PROCEDURE_FILE_FORMAT, exportedAt: new Date().toISOString(), procedures: items }, null, 2);
  }

  /** Import procedures from an export file. Returns the imported procedures. */
  async importJson(text: string): Promise<Procedure[]> {
    const parsed = JSON.parse(text);
    const items: unknown[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.procedures) ? parsed.procedures : [parsed];
    const all = await this.loadAll();
    const imported: Procedure[] = [];
    for (const raw of items) {
      const proc = sanitizeProcedure(raw);
      if (!proc) continue;
      if (all[proc.id]) proc.id = newId('p_');
      proc.source = 'import';
      proc.runs = [];
      all[proc.id] = proc;
      imported.push(proc);
    }
    if (!imported.length) throw new Error('No valid procedure in file');
    await this.saveAll(all);
    return imported;
  }
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

/** Validate/normalize an untrusted procedure object (import). */
export function sanitizeProcedure(raw: any): Procedure | null {
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !Array.isArray(raw.steps)) return null;
  const now = Date.now();
  const steps: ProcedureStep[] = raw.steps
    .filter((s: any) => s && STEP_TYPES.includes(s.type))
    .map((s: any) => ({
      id: typeof s.id === 'string' ? s.id : newId('s_'),
      type: s.type,
      description: String(s.description ?? s.type).slice(0, 300),
      target: s.target && Array.isArray(s.target.candidates)
        ? {
          candidates: s.target.candidates.filter((c: unknown) => typeof c === 'string').slice(0, 10),
          label: typeof s.target.label === 'string' ? s.target.label : undefined,
          text: typeof s.target.text === 'string' ? s.target.text : undefined,
          role: typeof s.target.role === 'string' ? s.target.role : undefined,
          frameUrl: typeof s.target.frameUrl === 'string' ? s.target.frameUrl : undefined,
        }
        : undefined,
      value: typeof s.value === 'string' ? s.value : s.value !== undefined ? String(s.value) : undefined,
      schema: s.schema && typeof s.schema === 'object' ? s.schema : undefined,
      saveAs: typeof s.saveAs === 'string' ? s.saveAs : undefined,
      instruction: typeof s.instruction === 'string' ? s.instruction : undefined,
      optional: s.optional === true,
      approval: ['auto', 'always', 'never'].includes(s.approval) ? s.approval : 'auto',
      pageUrl: typeof s.pageUrl === 'string' ? s.pageUrl : undefined,
      thumbnail: typeof s.thumbnail === 'string' && s.thumbnail.startsWith('data:image/') ? s.thumbnail : undefined,
    }));
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('p_'),
    name: raw.name.slice(0, 120),
    description: typeof raw.description === 'string' ? raw.description : '',
    domain: typeof raw.domain === 'string' ? raw.domain : undefined,
    startUrl: typeof raw.startUrl === 'string' ? raw.startUrl : undefined,
    params: Array.isArray(raw.params)
      ? raw.params
        .filter((p: any) => p && typeof p.name === 'string' && /^[\w.-]+$/.test(p.name))
        .map((p: any) => ({
          name: p.name,
          label: typeof p.label === 'string' ? p.label : undefined,
          type: ['text', 'number', 'date', 'select', 'secret'].includes(p.type) ? p.type : 'text',
          required: p.required !== false,
          default: p.type === 'secret' ? undefined : (typeof p.default === 'string' ? p.default : undefined),
          options: Array.isArray(p.options) ? p.options.map(String) : undefined,
          description: typeof p.description === 'string' ? p.description : undefined,
        }))
      : [],
    steps,
    notes: typeof raw.notes === 'string' ? raw.notes : undefined,
    version: Number(raw.version) || 1,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: now,
    source: 'import',
    runs: [],
  };
}

/** Human-readable Markdown rendering (documentation/sharing, not a source format). */
export function procedureToMarkdown(p: Procedure): string {
  const lines: string[] = [`# ${p.name}`, ''];
  if (p.description) lines.push(p.description, '');
  if (p.domain || p.startUrl) lines.push(`- Dominio: ${p.domain ?? ''}${p.startUrl ? ` · Avvio: ${p.startUrl}` : ''}`);
  if (p.params.length) {
    lines.push('', '## Parametri', '');
    for (const prm of p.params) {
      lines.push(`- \`${prm.name}\` (${prm.type}${prm.required ? ', obbligatorio' : ''})${prm.label ? ` — ${prm.label}` : ''}${prm.default ? ` · default: ${prm.default}` : ''}`);
    }
  }
  lines.push('', '## Passi', '');
  p.steps.forEach((s, i) => {
    const target = s.target ? ` → ${s.target.label || s.target.text || s.target.candidates[0] || ''}` : '';
    const value = s.value ? ` = \`${s.value}\`` : '';
    lines.push(`${i + 1}. **${s.type}**${target}${value}${s.optional ? ' _(facoltativo)_' : ''} — ${s.description}`);
    if (s.instruction) lines.push(`   - ${s.instruction}`);
  });
  if (p.notes) lines.push('', '## Note', '', p.notes);
  return lines.join('\n') + '\n';
}
