/**
 * @jest-environment node
 */
import path from 'path';
import { buildSync } from 'esbuild';
import type { Browser, Page } from 'playwright-core';
import { buildProcedure, CapturedAction, makeParam } from '../../src/procedures/builder';
import { ProcedureRunner } from '../../src/procedures/runner';
import { describeIfChromium, launch, openFixture } from './helpers';

/** The recording content script, bundled as the extension does (classic script). */
function recorderSource(): string {
  const out = buildSync({
    entryPoints: [path.resolve(__dirname, '../../src/content/recordingContentScript.ts')],
    bundle: true, write: false, format: 'iife', target: 'chrome120',
  });
  return out.outputFiles[0].text;
}

/** Inject the recorder with a chrome.runtime stub that collects the steps. */
async function startRecorder(page: Page, source: string): Promise<void> {
  await page.evaluate(() => {
    (window as any).__steps = [];
    (window as any).chrome = {
      runtime: {
        sendMessage: (m: any) => { if (m.action === 'recordingStep') (window as any).__steps.push(m.step); },
        onMessage: { addListener: () => undefined },
      },
    };
  });
  await page.addScriptTag({ content: source });
}

async function capturedSteps(page: Page): Promise<CapturedAction[]> {
  return page.evaluate(() => (window as any).__steps);
}

describeIfChromium('procedures: record → build → replay on real Chromium', () => {
  let browser: Browser;
  const source = recorderSource();
  beforeAll(async () => { browser = await launch(); }, 30000);
  afterAll(async () => { await browser?.close(); });

  it('records a multi-tab form with a custom dropdown and replays it with a new parameter', async () => {
    const page = await openFixture(browser, 'form.html');
    await startRecorder(page, source);
    await page.fill('#rs', 'ACME srl');
    await page.press('#rs', 'Tab');
    await page.fill('#piva', '01234567890');
    await page.locator('#piva').blur();
    await page.click('#cat');
    await page.click('text=Consulenza');
    await page.click('#t2');
    await page.fill('#iban', 'IT60X0542811101000000123456');
    await page.locator('#iban').blur();
    await page.selectOption('#term', '60');
    await page.click('button[type=submit]');
    expect(await page.textContent('#result')).toContain('Salvato: ACME srl');

    const actions = await capturedSteps(page);
    expect(actions.map(a => a.type)).toEqual(['type', 'type', 'click', 'click', 'click', 'type', 'select', 'click']);

    let proc = buildProcedure(actions, { name: 'Nuovo fornitore', source: 'recording', startUrl: page.url() });
    // The IBAN is sensitive: never stored, turned into a required parameter
    const ibanStep = proc.steps.find(s => s.target?.label === 'IBAN')!;
    expect(ibanStep.value).toMatch(/^\{\{\w+\}\}$/);
    expect(JSON.stringify(proc)).not.toContain('IT60X0542811101000000123456');
    const ibanParam = proc.params.find(p => `{{${p.name}}}` === ibanStep.value)!;

    // Operator turns the company name into a parameter
    const rsIndex = proc.steps.findIndex(s => s.target?.label === 'Ragione sociale');
    proc = makeParam(proc, rsIndex, 'ragione_sociale');
    expect(proc.params.find(p => p.name === 'ragione_sociale')?.default).toBe('ACME srl');

    const fresh = await openFixture(browser, 'form.html');
    const report = await new ProcedureRunner(fresh as any).run(proc, {
      params: { ragione_sociale: 'Beta spa', [ibanParam.name]: 'IT02L1234512345123456789012' },
      approvalMode: 'off',
    });
    expect(report.log.join('\n')).not.toContain('✗');
    expect(report.status).toBe('success');
    expect(await fresh.textContent('#result')).toBe('Salvato: Beta spa / Consulenza / 60');
  }, 60000);

  it('records actions inside open shadow roots and replays them', async () => {
    const page = await openFixture(browser, 'shadow.html');
    await startRecorder(page, source);
    await page.fill('x-card #n', 'Mario');
    await page.locator('x-card #n').blur();
    await page.click('x-card #b');
    const actions = await capturedSteps(page);
    expect(actions.map(a => a.type)).toEqual(['type', 'click']);
    const proc = buildProcedure(actions, { name: 'Shadow', source: 'recording', startUrl: page.url() });
    const fresh = await openFixture(browser, 'shadow.html');
    const report = await new ProcedureRunner(fresh as any).run(proc, { approvalMode: 'off' });
    expect(report.status).toBe('success');
    expect(await fresh.evaluate(() => document.body.dataset.sent)).toBe('Mario');
  }, 60000);

  it('never sends password values', async () => {
    const page = await openFixture(browser, 'form.html');
    await page.evaluate(() => {
      const i = document.createElement('input');
      i.type = 'password'; i.id = 'pw'; i.setAttribute('aria-label', 'Password');
      document.body.appendChild(i);
    });
    await startRecorder(page, source);
    await page.fill('#pw', 'segretissima');
    await page.locator('#pw').blur();
    const actions = await capturedSteps(page);
    expect(JSON.stringify(actions)).not.toContain('segretissima');
    const proc = buildProcedure(actions, { name: 'Login', source: 'recording', startUrl: page.url() });
    expect(proc.params[0]).toMatchObject({ type: 'secret', required: true });
  }, 60000);

  it('stops with a resumable report when an element is gone, and uses role/label fallbacks', async () => {
    const page = await openFixture(browser, 'form.html');
    const proc = buildProcedure([
      { type: 'type', candidates: ['#does-not-exist'], elementLabel: 'Ragione sociale', role: 'textbox', text: 'Gamma' },
      { type: 'click', candidates: ['#nope'], elementText: 'Introvabile', role: 'button' },
    ], { name: 'Fallback', source: 'manual', startUrl: page.url() });
    const report = await new ProcedureRunner(page as any).run(proc, { approvalMode: 'off', locatorTimeoutMs: 1500 });
    // Label fallback found the field even though the CSS candidate is wrong
    expect(await page.inputValue('#rs')).toBe('Gamma');
    expect(report.status).toBe('needs_agent');
    expect(report.stoppedAt).toBe(2);
  }, 60000);

  it('reports missing required parameters before touching the page', async () => {
    const page = await openFixture(browser, 'form.html');
    const proc = buildProcedure([{ type: 'type', candidates: ['#rs'], elementLabel: 'Ragione sociale', text: '{{nome}}' }], { name: 'P', source: 'manual', startUrl: page.url() });
    const report = await new ProcedureRunner(page as any).run(proc, {});
    expect(report.status).toBe('failed');
    expect(report.missingParams).toEqual(['nome']);
  }, 30000);
});
