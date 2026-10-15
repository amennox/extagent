import { jest } from '@jest/globals';
import { Recording } from '../../../../src/background/recordingManager';

// Mock RecordingManager
const mockGetRecording = jest.fn<() => Promise<Recording | null>>();

jest.mock('../../../../src/background/recordingManager', () => ({
  RecordingManager: {
    getInstance: () => ({
      getRecording: mockGetRecording,
      listRecordings: jest.fn(() => Promise.resolve([])),
    }),
  },
}));

// Mock approval (always approve)
const mockRequestApproval = jest.fn(() => Promise.resolve(true));
jest.mock('../../../../src/agent/approvalManager', () => ({
  requestApproval: (...args: any[]) => mockRequestApproval(...(args as [])),
}));

// Mock utils: withActivePage passes the same page through
jest.mock('../../../../src/agent/tools/utils', () => ({
  withActivePage: jest.fn((page: any, fn: any) => fn(page)),
  getCurrentTabId: jest.fn(() => Promise.resolve(1)),
  MAX_RETURN_CHARS: 100000,
  setMaxReturnChars: jest.fn(),
  truncate: (s: string) => s,
}));

import { playAutomation } from '../../../../src/agent/tools/automationTools';

function createMockPage(overrides: Record<string, any> = {}) {
  return {
    goto: jest.fn(() => Promise.resolve()),
    waitForSelector: jest.fn(() => Promise.resolve({})),
    click: jest.fn(() => Promise.resolve()),
    fill: jest.fn(() => Promise.resolve()),
    press: jest.fn(() => Promise.resolve()),
    ...overrides,
  } as any;
}

const sampleRecording: Recording = {
  name: 'login-seq',
  description: 'Accesso portale',
  createdAt: '2026-05-09T10:00:00.000Z',
  steps: [
    { type: 'click', selector: '#btn-login', candidates: ['#btn-login'], description: 'click su "Login"' },
    { type: 'type', selector: '[name="username"]', candidates: ['[name="username"]'], text: 'admin', description: 'digitato "admin" in username' },
  ],
};

describe('play_automation (replay deterministico)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lancia errore se la registrazione non esiste', async () => {
    mockGetRecording.mockResolvedValue(null);

    const tool = playAutomation(createMockPage());
    const result = JSON.parse(await tool.func(JSON.stringify({ recordingName: 'missing' })));

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('Recording not found');
  });

  it('esegue i passi direttamente via playwright (nessun prompt LLM)', async () => {
    mockGetRecording.mockResolvedValue(sampleRecording);
    const page = createMockPage();

    const tool = playAutomation(page);
    const result = JSON.parse(await tool.func(JSON.stringify({ recordingName: 'login-seq' })));

    expect(result.success).toBe(true);
    expect(page.click).toHaveBeenCalledWith('#btn-login', expect.any(Object));
    expect(page.fill).toHaveBeenCalledWith('[name="username"]', 'admin', expect.any(Object));
    expect(result.prompt).toBeUndefined();
  });

  it('restituisce stepsExecuted pari al numero di step eseguiti', async () => {
    mockGetRecording.mockResolvedValue(sampleRecording);

    const tool = playAutomation(createMockPage());
    const result = JSON.parse(await tool.func(JSON.stringify({ recordingName: 'login-seq' })));

    expect(result.stepsExecuted).toBe(sampleRecording.steps.length);
  });

  it('sostituisce i params {{...}} nel testo digitato', async () => {
    mockGetRecording.mockResolvedValue({
      ...sampleRecording,
      steps: [{ type: 'type', selector: '#q', candidates: ['#q'], text: '{{termine}}' }],
    });
    const page = createMockPage();

    const tool = playAutomation(page);
    await tool.func(JSON.stringify({ recordingName: 'login-seq', params: { termine: 'fornitori' } }));

    expect(page.fill).toHaveBeenCalledWith('#q', 'fornitori', expect.any(Object));
  });

  it('su fallimento restituisce failedStep e recovery per il fallback LLM', async () => {
    mockGetRecording.mockResolvedValue(sampleRecording);
    const page = createMockPage({
      waitForSelector: jest.fn(() => Promise.reject(new Error('timeout'))),
    });

    const tool = playAutomation(page);
    const result = JSON.parse(await tool.func(JSON.stringify({ recordingName: 'login-seq', instruction: 'se compare il popup chiudilo' })));

    expect(result.success).toBe(false);
    expect(result.failedStep.index).toBe(1);
    expect(result.recovery).toContain('failed at step 1');
    expect(result.recovery).toContain('se compare il popup chiudilo');
  });
});
