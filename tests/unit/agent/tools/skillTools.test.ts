import { jest } from '@jest/globals';
import { SkillDefinition } from '../../../../src/agent/skillManager';

// Mock SkillManager
const mockGetSkill = jest.fn<() => Promise<SkillDefinition | null>>();

jest.mock('../../../../src/agent/skillManager', () => ({
  SkillManager: {
    getInstance: () => ({
      getSkill: mockGetSkill,
    }),
  },
}));

// Mock RecordingManager (play steps)
const mockGetRecording = jest.fn<() => Promise<any>>();
jest.mock('../../../../src/background/recordingManager', () => ({
  RecordingManager: {
    getInstance: () => ({
      getRecording: mockGetRecording,
    }),
  },
}));

// Mock approval (always approve)
jest.mock('../../../../src/agent/approvalManager', () => ({
  requestApproval: jest.fn(() => Promise.resolve(true)),
}));

// Mock utils: withActivePage passes the same page through
jest.mock('../../../../src/agent/tools/utils', () => ({
  withActivePage: jest.fn((page: any, fn: any) => fn(page)),
  getCurrentTabId: jest.fn(() => Promise.resolve(1)),
  MAX_RETURN_CHARS: 100000,
  setMaxReturnChars: jest.fn(),
  truncate: (s: string) => s,
}));

// Mock extraction tools (extract/paginate steps)
const mockExtractFunc = jest.fn<(input: string) => Promise<string>>();
jest.mock('../../../../src/agent/tools/extractionTools', () => ({
  extractWithSchema: () => ({ name: 'extract_with_schema', func: mockExtractFunc }),
  paginateAndCollect: () => ({ name: 'paginate_and_collect', func: mockExtractFunc }),
}));

const mockFillFunc = jest.fn<(input: string) => Promise<string>>();
jest.mock('../../../../src/agent/tools/formTools', () => ({
  fillFormFromData: () => ({ name: 'fill_form_from_data', func: mockFillFunc }),
}));

import { useSkill } from '../../../../src/agent/tools/skillTools';

function createMockPage() {
  return {
    goto: jest.fn(() => Promise.resolve()),
    waitForSelector: jest.fn(() => Promise.resolve({})),
    click: jest.fn(() => Promise.resolve()),
    fill: jest.fn(() => Promise.resolve()),
  } as any;
}

function createMockProvider(responses: string[] = ['computed-value']) {
  let call = 0;
  return {
    createMessage: jest.fn(() => {
      const text = responses[Math.min(call++, responses.length - 1)];
      return (async function* () {
        yield { type: 'text', text };
      })();
    }),
    getModel: () => ({ id: 'm', info: { name: 'm', inputPrice: 0, outputPrice: 0 } }),
    getDefaultProfile: () => null,
  } as any;
}

const sampleSkill: SkillDefinition = {
  title: 'Raccolta gare',
  description: 'Estrae le gare pubbliche',
  steps: [
    { type: 'navigate', payload: 'https://portale.it/{{section}}', raw: '`navigate: https://portale.it/{{section}}`' },
    { type: 'extract', payload: '{"schema":{"type":"array"}}', raw: '`extract: {"schema":{"type":"array"}}`', saveAs: 'gare' },
  ],
  raw: '',
};

describe('use_skill (runner ibrido)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExtractFunc.mockResolvedValue('[{"nome":"Gara 1"}]');
    mockFillFunc.mockResolvedValue('Filled 2 fields');
  });

  it('lancia errore se la skill non esiste', async () => {
    mockGetSkill.mockResolvedValue(null);

    const tool = useSkill(createMockPage(), createMockProvider());
    const result = JSON.parse(await tool.func(JSON.stringify({ skillTitle: 'missing' })));

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('Skill not found');
  });

  it('esegue i passi in ordine (navigate prima di extract)', async () => {
    mockGetSkill.mockResolvedValue(sampleSkill);
    const page = createMockPage();

    const tool = useSkill(page, createMockProvider());
    const result = JSON.parse(await tool.func(JSON.stringify({ skillTitle: 'Raccolta gare', params: { section: 'gare' } })));

    expect(result.success).toBe(true);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(result.log[0].type).toBe('navigate');
    expect(result.log[1].type).toBe('extract');
  });

  it('sostituisce i parametri {{param}} nei payload', async () => {
    mockGetSkill.mockResolvedValue(sampleSkill);
    const page = createMockPage();

    const tool = useSkill(page, createMockProvider());
    const result = JSON.parse(
      await tool.func(JSON.stringify({ skillTitle: 'Raccolta gare', params: { section: 'gare-pubbliche' } }))
    );

    expect(result.success).toBe(true);
    expect(page.goto).toHaveBeenCalledWith('https://portale.it/gare-pubbliche', expect.any(Object));
  });

  it('restituisce stepsExecuted corretto', async () => {
    mockGetSkill.mockResolvedValue(sampleSkill);

    const tool = useSkill(createMockPage(), createMockProvider());
    const result = JSON.parse(await tool.func(JSON.stringify({ skillTitle: 'Raccolta gare', params: { section: 'x' } })));

    expect(result.stepsExecuted).toBe(sampleSkill.steps.length);
  });

  it('salva il risultato extract nella variabile indicata da saveAs', async () => {
    mockGetSkill.mockResolvedValue(sampleSkill);

    const tool = useSkill(createMockPage(), createMockProvider());
    const result = JSON.parse(await tool.func(JSON.stringify({ skillTitle: 'Raccolta gare', params: { section: 'x' } })));

    expect(result.variables.gare).toEqual([{ nome: 'Gara 1' }]);
  });

  it('esegue step compute con una singola chiamata LLM e salva la variabile', async () => {
    const skill: SkillDefinition = {
      title: 'Con compute',
      description: '',
      steps: [
        { type: 'extract', payload: '{"schema":{"type":"array"}}', raw: '', saveAs: 'dati' },
        { type: 'compute', payload: 'prendi il nome dal primo elemento di {{dati}}', raw: '', saveAs: 'nome' },
      ],
      raw: '',
    };
    mockGetSkill.mockResolvedValue(skill);
    const provider = createMockProvider(['Gara 1']);

    const tool = useSkill(createMockPage(), provider);
    const result = JSON.parse(await tool.func(JSON.stringify({ skillTitle: 'Con compute' })));

    expect(result.success).toBe(true);
    expect(result.variables.nome).toBe('Gara 1');
    expect(provider.createMessage).toHaveBeenCalledTimes(1);
    // The compute instruction must contain the resolved variable, not the {{ref}}
    const computeUserMsg = (provider.createMessage as jest.Mock).mock.calls[0][1] as any[];
    expect(computeUserMsg[0].content).toContain('Gara 1');
  });

  it('su step fallito restituisce report strutturato con recovery', async () => {
    mockGetSkill.mockResolvedValue(sampleSkill);
    mockExtractFunc.mockResolvedValue('Error: extraction failed after 3 attempts');

    const tool = useSkill(createMockPage(), createMockProvider());
    const result = JSON.parse(await tool.func(JSON.stringify({ skillTitle: 'Raccolta gare', params: { section: 'x' } })));

    expect(result.success).toBe(false);
    expect(result.stepsExecuted).toBe(1);
    expect(result.recovery).toContain('failed at step 2');
  });

  it('skill senza step strutturati → fallback legacy a prompt testuale', async () => {
    const freeformSkill: SkillDefinition = {
      title: 'Libera',
      description: 'Solo testo',
      steps: [],
      raw: '---\ntitle: Libera\ndescription: Solo testo\n---\n\nVai su {{sito}} e riassumi.',
    };
    mockGetSkill.mockResolvedValue(freeformSkill);

    const tool = useSkill(createMockPage(), createMockProvider());
    const result = await tool.func(JSON.stringify({ skillTitle: 'Libera', params: { sito: 'example.com' } }));

    expect(result).toContain('SKILL: "Libera"');
    expect(result).toContain('example.com');
    expect(result).not.toContain('{{sito}}');
  });
});
