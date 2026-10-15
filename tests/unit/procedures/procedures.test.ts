import { buildProcedure, CapturedAction, makeParam, suggestParams, undeclaredParams } from '../../../src/procedures/builder';
import { migrateLegacyAutomations } from '../../../src/procedures/migration';
import { missingParams, ProcedureRunner } from '../../../src/procedures/runner';
import { sensitiveKind } from '../../../src/procedures/sensitive';
import { procedureToMarkdown, ProcedureStore, sanitizeProcedure } from '../../../src/procedures/store';

/** In-memory chrome.storage.local */
function memoryStorage(initial: Record<string, any> = {}) {
  const data: Record<string, any> = JSON.parse(JSON.stringify(initial));
  (chrome.storage.local.get as jest.Mock).mockImplementation(async (keys: any) => {
    if (typeof keys === 'string') return { [keys]: data[keys] };
    if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, data[k]]));
    return { ...data };
  });
  (chrome.storage.local.set as jest.Mock).mockImplementation(async (obj: Record<string, any>) => {
    Object.assign(data, JSON.parse(JSON.stringify(obj)));
  });
  return data;
}

const recorded: CapturedAction[] = [
  { type: 'navigate', url: 'https://www.erp.example.com/fornitori/nuovo' },
  { type: 'type', candidates: ['#rs'], elementLabel: 'Ragione sociale', text: 'AC' },
  { type: 'type', candidates: ['#rs'], elementLabel: 'Ragione sociale', text: 'ACME srl' },
  { type: 'type', candidates: ['#pw'], elementLabel: 'Password', inputType: 'password', text: '' },
  { type: 'type', candidates: ['#iban'], elementLabel: 'IBAN', text: 'IT60X0542811101000000123456' },
  { type: 'select', candidates: ['#term'], elementLabel: 'Termini', text: '60 giorni' },
  { type: 'click', candidates: ['button[type=submit]'], elementText: 'Salva', role: 'button', thumbnail: 'data:image/jpeg;base64,AAA' },
];

describe('sensitive values', () => {
  it('detects passwords, IBAN, tax codes, valid card numbers and sensitive labels', () => {
    expect(sensitiveKind('', 'Password', 'password')).toBe('password');
    expect(sensitiveKind('IT60X0542811101000000123456')).toBe('iban');
    expect(sensitiveKind('RSSMRA80A01H501U')).toBe('codice_fiscale');
    expect(sensitiveKind('4111 1111 1111 1111')).toBe('carta');
    expect(sensitiveKind('1234 5678 9012 3456')).toBeNull(); // fails Luhn
    expect(sensitiveKind('123', 'CVV')).toBe('cvv');
    expect(sensitiveKind('abc', 'API token')).toBe('secret');
    expect(sensitiveKind('ACME srl', 'Ragione sociale')).toBeNull();
  });
});

describe('buildProcedure', () => {
  const proc = buildProcedure(recorded, { name: 'Nuovo fornitore', source: 'recording' });

  it('merges repeated typing, keeps order and maps actions to steps', () => {
    expect(proc.steps.map(s => s.type)).toEqual(['navigate', 'fill', 'fill', 'fill', 'select', 'click']);
    expect(proc.steps[1].value).toBe('ACME srl');
    expect(proc.steps[5].thumbnail).toBe('data:image/jpeg;base64,AAA');
    expect(proc.domain).toBe('erp.example.com');
    expect(proc.startUrl).toBe('https://www.erp.example.com/fornitori/nuovo');
  });

  it('never stores sensitive values: they become required parameters', () => {
    expect(JSON.stringify(proc)).not.toContain('IT60X0542811101000000123456');
    expect(proc.params).toEqual([
      expect.objectContaining({ name: 'password', type: 'secret', required: true }),
      expect.objectContaining({ name: 'iban', type: 'text', required: true }),
    ]);
    expect(proc.steps[2].value).toBe('{{password}}');
    expect(proc.steps[3].value).toBe('{{iban}}');
  });

  it('adds a start navigation when the capture began mid-page', () => {
    const p = buildProcedure([{ type: 'click', candidates: ['#a'], elementText: 'A', pageUrl: 'https://x.it/p' }], { name: 'p', source: 'agent' });
    expect(p.steps[0]).toMatchObject({ type: 'navigate', value: 'https://x.it/p' });
  });

  it('suggests and creates parameters from literal values', () => {
    const sugg = suggestParams(proc);
    expect(sugg.map(s => s.name)).toEqual(['ragione_sociale', 'termini']);
    const p2 = makeParam(proc, 1, 'Ragione Sociale');
    expect(p2.steps[1].value).toBe('{{ragione_sociale}}');
    expect(p2.params.find(p => p.name === 'ragione_sociale')).toMatchObject({ default: 'ACME srl', required: true });
    expect(undeclaredParams({ ...p2, params: [] })).toEqual(['ragione_sociale', 'password', 'iban']);
  });

  it('computes missing required parameters (defaults count as provided)', () => {
    const p2 = makeParam(proc, 1, 'ragione_sociale');
    expect(missingParams(p2, {})).toEqual(['password', 'iban']);
    expect(missingParams(p2, { password: 'x', iban: 'y' })).toEqual([]);
  });
});

describe('ProcedureStore', () => {
  beforeEach(() => memoryStorage());

  it('saves, versions, finds by name and by domain', async () => {
    const store = ProcedureStore.getInstance();
    const p = await store.save(buildProcedure(recorded, { name: 'Nuovo fornitore', source: 'recording' }));
    expect(p.version).toBe(1);
    const p2 = await store.save({ ...p, description: 'x' });
    expect(p2.version).toBe(2);
    expect(p2.createdAt).toBe(p.createdAt);
    expect((await store.findByName('nuovo FORNITORE'))!.id).toBe(p.id);
    expect((await store.findByName('fornitore'))!.id).toBe(p.id);
    expect(await store.listForDomain('https://app.erp.example.com/x')).toHaveLength(1);
    expect(await store.listForDomain('https://other.com')).toHaveLength(0);
  });

  it('keeps the last 20 runs', async () => {
    const store = ProcedureStore.getInstance();
    const p = await store.save(buildProcedure(recorded, { name: 'R', source: 'manual' }));
    for (let i = 0; i < 25; i++) await store.recordRun(p.id, { at: i, outcome: 'success', mode: 'direct', durationMs: 1, stepsDone: 1 });
    const runs = (await store.get(p.id))!.runs;
    expect(runs).toHaveLength(20);
    expect(runs[0].at).toBe(24);
  });

  it('exports and re-imports procedures (new id on collision, runs dropped, input sanitized)', async () => {
    const store = ProcedureStore.getInstance();
    const p = await store.save(buildProcedure(recorded, { name: 'Export me', source: 'recording' }));
    await store.recordRun(p.id, { at: 1, outcome: 'failure', mode: 'direct', durationMs: 1, stepsDone: 0 });
    const json = store.exportJson([(await store.get(p.id))!]);
    expect(JSON.parse(json).format).toBe('dommotion-procedure@1');
    const [imported] = await store.importJson(json);
    expect(imported.id).not.toBe(p.id);
    expect(imported.runs).toEqual([]);
    expect(imported.source).toBe('import');
    await expect(store.importJson('{"foo": 1}')).rejects.toThrow('No valid procedure');
    expect(sanitizeProcedure({ name: 'x', steps: [{ type: 'rm -rf' }, { type: 'click', target: { candidates: ['#a', 3] } }] })!.steps)
      .toEqual([expect.objectContaining({ type: 'click', target: expect.objectContaining({ candidates: ['#a'] }) })]);
    expect(sanitizeProcedure({ name: 'x', steps: [], params: [{ name: 'pw', type: 'secret', default: 'leak' }] })!.params[0].default).toBeUndefined();
  });

  it('duplicates and deletes', async () => {
    const store = ProcedureStore.getInstance();
    const p = await store.save(buildProcedure(recorded, { name: 'Dup', source: 'manual' }));
    const copy = await store.duplicate(p.id);
    expect(copy!.name).toBe('Dup (copia)');
    await store.delete(p.id);
    expect(await store.get(p.id)).toBeNull();
    expect(await store.list()).toHaveLength(1);
  });

  it('renders readable Markdown', () => {
    const md = procedureToMarkdown(buildProcedure(recorded, { name: 'Doc', description: 'Crea un fornitore', source: 'recording' }));
    expect(md).toContain('# Doc');
    expect(md).toContain('`iban` (text, obbligatorio)');
    expect(md).toContain('**fill** → Ragione sociale = `ACME srl`');
  });
});

describe('migrateLegacyAutomations', () => {
  it('turns legacy skills and recordings into procedures once, skipping auto recordings', async () => {
    const data = memoryStorage({
      recordings: {
        'login': { name: 'login', steps: [{ type: 'navigate', url: 'https://p.it' }, { type: 'type', candidates: ['#u'], elementLabel: 'Utente', text: '{{utente}}' }] },
        'auto: p.it 2026-01-01': { name: 'auto: p.it 2026-01-01', steps: [{ type: 'click', candidates: ['#x'] }] },
        'solo': { name: 'solo', description: 'registrazione', steps: [{ type: 'navigate', url: 'https://q.it' }, { type: 'click', candidates: ['#b'], elementText: 'Vai' }] },
      },
      skills: {
        'Gare': {
          title: 'Gare', description: 'Estrae gare', params: ['settore'],
          steps: [
            { type: 'play', payload: 'login' },
            { type: 'navigate', payload: 'https://p.it/gare?s={{settore}}' },
            { type: 'extract', payload: '{"type":"object","properties":{"titolo":{"type":"string"}}}', saveAs: 'gare' },
            { type: 'compute', payload: 'conta le gare in {{gare}}', saveAs: 'totale' },
            { type: 'export', payload: 'csv' },
          ],
          notes: ['Se compare un popup chiudilo'],
        },
      },
    });
    expect(await migrateLegacyAutomations()).toBe(2);
    const procs = Object.values(data.procedures) as any[];
    const gare = procs.find(p => p.name === 'Gare');
    expect(gare.steps.map((s: any) => s.type)).toEqual(['navigate', 'fill', 'navigate', 'extract', 'ai']);
    expect(gare.params.map((p: any) => p.name).sort()).toEqual(['settore', 'utente']);
    expect(gare.notes).toBe('Se compare un popup chiudilo');
    expect(procs.find(p => p.name === 'solo')).toBeTruthy();
    expect(procs.find(p => p.name.startsWith('auto:'))).toBeUndefined();
    expect(data.proceduresMigrated).toBe(true);
    // Legacy data untouched, migration not repeated
    expect(data.recordings.login).toBeTruthy();
    expect(await migrateLegacyAutomations()).toBe(0);
  });
});

describe('ProcedureRunner and secrets', () => {
  it('never sends secret parameter values to the agent', async () => {
    const proc = buildProcedure([], { name: 'Login', source: 'manual' });
    proc.params = [{ name: 'password', type: 'secret', required: true }, { name: 'utente', type: 'text', required: true }];
    proc.steps = [{ id: 's1', type: 'ai', description: 'Accedi', instruction: 'Accedi come {{utente}} con password {{password}}', approval: 'auto' }];
    const seen: string[] = [];
    const report = await new ProcedureRunner({} as any).run(proc, {
      params: { utente: 'mario', password: 'segretissima' },
      aiResolver: async (req) => { seen.push(req.instruction); return { ok: true }; },
    });
    expect(report.status).toBe('success');
    expect(seen[0]).toContain('mario');
    expect(seen[0]).not.toContain('segretissima');
  });

  it('stops between steps when cancelled', async () => {
    const proc = buildProcedure([], { name: 'X', source: 'manual' });
    proc.steps = [
      { id: 'a', type: 'ai', description: 'uno', instruction: 'uno', approval: 'auto' },
      { id: 'b', type: 'ai', description: 'due', instruction: 'due', approval: 'auto' },
    ];
    let cancelled = false;
    const report = await new ProcedureRunner({} as any).run(proc, {
      isCancelled: () => cancelled,
      aiResolver: async () => { cancelled = true; return { ok: true }; },
    });
    expect(report).toMatchObject({ status: 'cancelled', stepsDone: 1, stoppedAt: 1 });
  });
});
