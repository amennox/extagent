import { MemoryManager } from '../../../src/agent/MemoryManager';
import { MemoryService } from '../../../src/tracking/memoryService';

describe('MemoryManager', () => {
  afterEach(() => jest.restoreAllMocks());

  it('builds a hint with the top memories of a domain', async () => {
    jest.spyOn(MemoryService.getInstance(), 'getMemoriesByDomain').mockResolvedValue([
      { id: 1, domain: 'erp.it', taskDescription: 'Crea fornitore', toolSequence: ['click "Nuovo"', 'fill "Nome"'], createdAt: 1, validated: true },
      { id: 2, domain: 'erp.it', taskDescription: 'Cerca ordine', toolSequence: [], createdAt: 1 },
    ]);
    const res = await new MemoryManager().buildMemoryHint('erp.it', 'it');
    expect(res!.ids).toEqual([1, 2]);
    expect(res!.hint).toContain('Crea fornitore (validata)');
    expect(res!.hint).toContain('click "Nuovo" → fill "Nome"');
  });

  it('returns null without memories or on errors', async () => {
    jest.spyOn(MemoryService.getInstance(), 'getMemoriesByDomain').mockResolvedValueOnce([]);
    expect(await new MemoryManager().buildMemoryHint('x.it')).toBeNull();
    jest.spyOn(MemoryService.getInstance(), 'getMemoriesByDomain').mockRejectedValueOnce(new Error('boom'));
    expect(await new MemoryManager().buildMemoryHint('x.it')).toBeNull();
  });

  it('reads the memory toggle', async () => {
    (chrome.storage.sync.get as jest.Mock).mockResolvedValueOnce({ memoryEnabled: false });
    expect(await MemoryManager.isMemoryEnabled()).toBe(false);
  });
});
