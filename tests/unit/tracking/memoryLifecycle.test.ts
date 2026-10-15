import { MemoryService } from '../../../src/tracking/memoryService';

jest.mock('../../../src/background/utils', () => ({
  logWithTimestamp: jest.fn(),
}));

jest.mock('../../../src/tracking/domainUtils', () => ({
  normalizeDomain: (d: string) => (d || '').toLowerCase().replace(/^www\./, ''),
}));

const store: Record<string, any> = {};

beforeAll(() => {
  (global as any).chrome = {
    storage: {
      local: {
        get: jest.fn(async (key: string) => ({ [key]: store[key] })),
        set: jest.fn(async (data: Record<string, any>) => { Object.assign(store, data); }),
      },
    },
  };
});

beforeEach(() => {
  Object.keys(store).forEach(k => delete store[k]);
  (MemoryService as any).instance = undefined;
});

const svc = () => MemoryService.getInstance();

describe('ciclo di vita memoria basato su esiti', () => {
  it('reinforceMemories incrementa useCount e auto-valida dopo 2 riusi', async () => {
    const id = await svc().storeMemory({ domain: 'test.it', taskDescription: 'cerca fornitore', toolSequence: ['a'], createdAt: Date.now() });

    await svc().reinforceMemories([id]);
    let [m] = await svc().getMemoriesByDomain('test.it');
    expect(m.useCount).toBe(1);
    expect(m.validated).toBe(false);

    await svc().reinforceMemories([id]);
    [m] = await svc().getMemoriesByDomain('test.it');
    expect(m.useCount).toBe(2);
    expect(m.validated).toBe(true);
  });

  it('reinforceMemories con forceValidate (👍) valida subito', async () => {
    const id = await svc().storeMemory({ domain: 'test.it', taskDescription: 'x', toolSequence: [], createdAt: Date.now() });
    await svc().reinforceMemories([id], true);
    const [m] = await svc().getMemoriesByDomain('test.it');
    expect(m.validated).toBe(true);
  });

  it('penalizeMemories elimina le provisional (👎)', async () => {
    const id = await svc().storeMemory({ domain: 'test.it', taskDescription: 'sbagliata', toolSequence: [], createdAt: Date.now() });
    await svc().penalizeMemories([id]);
    const all = await svc().getMemoriesByDomain('test.it');
    expect(all).toHaveLength(0);
  });

  it('penalizeMemories indebolisce le validate e le demota a provisional a useCount 0', async () => {
    const id = await svc().storeMemory({ domain: 'test.it', taskDescription: 'valida', toolSequence: [], createdAt: Date.now(), validated: true, useCount: 1 });
    await svc().penalizeMemories([id]);
    const [m] = await svc().getMemoriesByDomain('test.it');
    expect(m.useCount).toBe(0);
    expect(m.validated).toBe(false);
  });

  it('cap per dominio: oltre 15 vengono potate le provisional meno usate', async () => {
    for (let i = 0; i < 16; i++) {
      await svc().storeMemory({ domain: 'cap.it', taskDescription: `task ${i}`, toolSequence: [], createdAt: Date.now(), useCount: i === 0 ? 0 : i });
    }
    const all = await svc().getMemoriesByDomain('cap.it');
    expect(all.length).toBeLessThanOrEqual(15);
    // la meno usata (task 0) è stata rimossa
    expect(all.map(m => m.taskDescription)).not.toContain('task 0');
  });

  it('memoria con recordingName viene restituita col link', async () => {
    await svc().storeMemory({ domain: 'rec.it', taskDescription: 'con replay', toolSequence: [], createdAt: Date.now(), recordingName: 'auto: rec.it 2026-07-07' });
    const [m] = await svc().getMemoriesByDomain('rec.it');
    expect(m.recordingName).toBe('auto: rec.it 2026-07-07');
  });

  it('decay: validata non usata da oltre 90 giorni non viene restituita', async () => {
    const old = Date.now() - 100 * 24 * 60 * 60 * 1000;
    const id = await svc().storeMemory({ domain: 'old.it', taskDescription: 'vecchia', toolSequence: [], createdAt: old, validated: true, useCount: 5 });
    // Forza updatedAt vecchio direttamente nello store
    const key = 'agent_memories_v2';
    store[key] = store[key].map((m: any) => m.id === String(id) ? { ...m, updatedAt: new Date(old).toISOString(), createdAt: new Date(old).toISOString() } : m);
    const all = await svc().getMemoriesByDomain('old.it');
    expect(all).toHaveLength(0);
  });
});
