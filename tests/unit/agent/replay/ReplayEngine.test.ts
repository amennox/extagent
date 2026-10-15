import { jest } from '@jest/globals';
import { ReplayEngine } from '../../../../src/agent/replay/ReplayEngine';
import { createReplayContext } from '../../../../src/agent/replay/expressionResolver';
import { Recording } from '../../../../src/background/recordingManager';

function createMockPage(overrides: Record<string, any> = {}) {
  return {
    goto: jest.fn(() => Promise.resolve()),
    waitForSelector: jest.fn(() => Promise.resolve({})),
    click: jest.fn(() => Promise.resolve()),
    fill: jest.fn(() => Promise.resolve()),
    selectOption: jest.fn(() => Promise.resolve()),
    check: jest.fn(() => Promise.resolve()),
    uncheck: jest.fn(() => Promise.resolve()),
    press: jest.fn(() => Promise.resolve()),
    waitForTimeout: jest.fn(() => Promise.resolve()),
    ...overrides,
  } as any;
}

function recording(steps: any[]): Recording {
  return { name: 'test', description: '', createdAt: '', steps };
}

describe('ReplayEngine', () => {
  it('esegue una sequenza completa con successo', async () => {
    const page = createMockPage();
    const engine = new ReplayEngine(page);

    const result = await engine.play(recording([
      { type: 'navigate', url: 'https://example.com' },
      { type: 'click', selector: '#btn', candidates: ['#btn'] },
      { type: 'type', selector: '#field', candidates: ['#field'], text: 'ciao' },
    ]));

    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(3);
    expect(page.goto).toHaveBeenCalledWith('https://example.com', expect.any(Object));
    expect(page.click).toHaveBeenCalledWith('#btn', expect.any(Object));
    expect(page.fill).toHaveBeenCalledWith('#field', 'ciao', expect.any(Object));
  });

  it('prova i candidati in ordine (self-healing)', async () => {
    const page = createMockPage({
      waitForSelector: jest.fn((sel: string) =>
        sel === '#broken' ? Promise.reject(new Error('timeout')) : Promise.resolve({})
      ),
    });
    const engine = new ReplayEngine(page);

    const result = await engine.play(recording([
      { type: 'click', selector: '#broken', candidates: ['#broken', '[name="ok"]'] },
    ]), { locatorTimeoutMs: 10 });

    expect(result.success).toBe(true);
    expect(result.results[0].selectorUsed).toBe('[name="ok"]');
    expect(page.click).toHaveBeenCalledWith('[name="ok"]', expect.any(Object));
  });

  it('usa il fallback testuale se tutti i selettori falliscono', async () => {
    const page = createMockPage({
      waitForSelector: jest.fn((sel: string) =>
        sel.startsWith('text=') ? Promise.resolve({}) : Promise.reject(new Error('timeout'))
      ),
    });
    const engine = new ReplayEngine(page);

    const result = await engine.play(recording([
      { type: 'click', selector: '#gone', candidates: ['#gone'], elementText: 'Cerca' },
    ]), { locatorTimeoutMs: 10 });

    expect(result.success).toBe(true);
    expect(result.results[0].selectorUsed).toBe('text=Cerca');
  });

  it('risolve le espressioni {{...}} nel testo digitato', async () => {
    const page = createMockPage();
    const engine = new ReplayEngine(page);
    const ctx = createReplayContext({ cliente: 'ACME' });

    const result = await engine.play(recording([
      { type: 'type', selector: '#field', candidates: ['#field'], text: '{{cliente}}' },
    ]), { context: ctx });

    expect(result.success).toBe(true);
    expect(page.fill).toHaveBeenCalledWith('#field', 'ACME', expect.any(Object));
  });

  it('su elemento non trovato ritorna report con failedStep e remainingSteps', async () => {
    const page = createMockPage({
      waitForSelector: jest.fn(() => Promise.reject(new Error('timeout'))),
    });
    const engine = new ReplayEngine(page);

    const result = await engine.play(recording([
      { type: 'click', selector: '#gone', candidates: ['#gone'] },
      { type: 'type', selector: '#next', text: 'x' },
    ]), { locatorTimeoutMs: 10 });

    expect(result.success).toBe(false);
    expect(result.stepsExecuted).toBe(0);
    expect(result.failedStep?.index).toBe(0);
    expect(result.remainingSteps).toHaveLength(1);
  });

  it('richiede approvazione per step rischiosi (submit-like)', async () => {
    const page = createMockPage();
    const engine = new ReplayEngine(page);
    const onApprovalNeeded = jest.fn(() => Promise.resolve(true));

    await engine.play(recording([
      { type: 'click', selector: '#send', candidates: ['#send'], elementText: 'Invia richiesta' },
    ]), { onApprovalNeeded: onApprovalNeeded as any });

    expect(onApprovalNeeded).toHaveBeenCalled();
  });

  it('interrompe il replay se lo step rischioso viene rifiutato', async () => {
    const page = createMockPage();
    const engine = new ReplayEngine(page);

    const result = await engine.play(recording([
      { type: 'click', selector: '#send', candidates: ['#send'], elementText: 'Conferma ordine' },
      { type: 'type', selector: '#x', text: 'dopo' },
    ]), { onApprovalNeeded: (() => Promise.resolve(false)) as any });

    expect(result.success).toBe(false);
    expect(result.results[0].status).toBe('rejected');
    expect(page.click).not.toHaveBeenCalled();
  });

  it('non richiede approvazione per click normali', async () => {
    const page = createMockPage();
    const engine = new ReplayEngine(page);
    const onApprovalNeeded = jest.fn(() => Promise.resolve(true));

    await engine.play(recording([
      { type: 'click', selector: '#tab', candidates: ['#tab'], elementText: 'Dettaglio fornitore' },
    ]), { onApprovalNeeded: onApprovalNeeded as any });

    expect(onApprovalNeeded).not.toHaveBeenCalled();
  });

  it('gestisce select e checkbox', async () => {
    const page = createMockPage();
    const engine = new ReplayEngine(page);

    const result = await engine.play(recording([
      { type: 'select', selector: '#sel', candidates: ['#sel'], text: 'opt1' },
      { type: 'check', selector: '#chk', candidates: ['#chk'], text: 'true' },
      { type: 'check', selector: '#chk2', candidates: ['#chk2'], text: 'false' },
    ]));

    expect(result.success).toBe(true);
    expect(page.selectOption).toHaveBeenCalledWith('#sel', { value: 'opt1' });
    expect(page.check).toHaveBeenCalledWith('#chk', expect.any(Object));
    expect(page.uncheck).toHaveBeenCalledWith('#chk2', expect.any(Object));
  });
});
