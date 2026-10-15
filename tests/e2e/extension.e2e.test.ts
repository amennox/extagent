/**
 * @jest-environment node
 *
 * Smoke test of the BUILT extension (dist/) loaded in real Chromium:
 * service worker boot, options page (procedure editor), side panel,
 * recording through chrome.scripting, direct procedure run through
 * playwright-crx + chrome.debugger.
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { chromium, BrowserContext, Page, Worker } from 'playwright-core';
import { FIXTURES, chromiumAvailable } from './helpers';

const DIST = path.resolve(__dirname, '../../dist');
const canRun = chromiumAvailable() && fs.existsSync(path.join(DIST, 'manifest.json'));
const describeExt = canRun ? describe : describe.skip;

function serveFixtures(): Promise<{ server: http.Server; base: string }> {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const file = path.join(FIXTURES, decodeURIComponent((req.url ?? '/').split('?')[0]));
      if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

/**
 * Minimal OpenAI-compatible endpoint (SSE streaming) driven by a script:
 * lets the real extension run a full agent task with native tool calls.
 */
function mockLlmServer(script: (body: any, n: number) => Array<Record<string, unknown>>): Promise<{ server: http.Server; base: string; requests: any[] }> {
  const requests: any[] = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        requests.push(body);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
        for (const delta of script(body, requests.length)) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({ server, base: `http://127.0.0.1:${addr.port}`, requests });
    });
  });
}

/** Send a runtime message from an extension page and return the response. */
async function send(extPage: Page, message: Record<string, unknown>): Promise<any> {
  return extPage.evaluate((m) => new Promise(resolve => chrome.runtime.sendMessage(m, resolve)), message);
}

describeExt('built extension in Chromium', () => {
  let context: BrowserContext;
  let sw: Worker;
  let extId: string;
  let server: http.Server;
  let base: string;
  const errors: string[] = [];
  const swLogs: string[] = [];

  beforeAll(async () => {
    ({ server, base } = await serveFixtures());
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-ext-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: ['--headless=new', `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
      viewport: { width: 1200, height: 800 },
    });
    sw = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 20000 });
    extId = new URL(sw.url()).host;
    sw.on('console', msg => {
      swLogs.push(`[${msg.type()}] ${msg.text()}`);
      if (msg.type() === 'error') errors.push(msg.text());
    });
  }, 60000);

  afterAll(async () => {
    await context?.close();
    server?.close();
  });

  it('boots the service worker and migrates legacy recordings/skills into procedures', async () => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extId}/options.html`);
    await options.evaluate(async () => {
      await chrome.storage.local.set({
        proceduresMigrated: false,
        recordings: {
          'Login portale': {
            name: 'Login portale', description: 'vecchia registrazione', createdAt: new Date().toISOString(),
            steps: [
              { type: 'navigate', url: 'https://example.com/login' },
              { type: 'type', selector: '#user', candidates: ['#user'], elementLabel: 'Utente', text: '{{utente}}' },
              { type: 'click', selector: 'button', candidates: ['button'], elementText: 'Accedi' },
            ],
          },
        },
        skills: {},
      });
    });
    await options.goto(`chrome-extension://${extId}/options.html#procedures`);
    await options.waitForSelector('[data-testid="procedures-tab"]', { timeout: 15000 });
    await options.waitForSelector('text=Login portale', { timeout: 10000 });
    const procs = await options.evaluate(async () => (await chrome.storage.local.get('procedures')).procedures);
    const migrated = Object.values(procs as Record<string, any>).find((p: any) => p.name === 'Login portale') as any;
    expect(migrated.params.map((p: any) => p.name)).toEqual(['utente']);
    expect(migrated.steps.map((s: any) => s.type)).toEqual(['navigate', 'fill', 'click']);
    await options.close();
  }, 60000);

  it('records a procedure via chrome.scripting with thumbnails, then runs it via playwright-crx', async () => {
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extId}/options.html#procedures`);
    await options.evaluate(() => chrome.storage.sync.set({ approvalMode: 'off' }));

    const web = await context.newPage();
    await web.goto(`${base}/form.html`);
    await web.bringToFront();

    const started = await send(options, { action: 'startRecordingCapture', name: 'Nuovo fornitore' });
    expect(started.success).toBe(true);
    await web.waitForFunction(() => !!document.querySelector('[data-dommotion-recording]'), null, { timeout: 10000 });

    await web.fill('#rs', 'ACME srl');
    await web.locator('#rs').blur();
    await web.waitForTimeout(700);
    await web.click('#cat');
    await web.waitForTimeout(700);
    await web.click('text=Consulenza');
    await web.waitForTimeout(700);
    await web.fill('#piva', '01234567890');
    await web.locator('#piva').blur();
    await web.click('#t2');
    await web.fill('#iban', 'IT60X0542811101000000123456');
    await web.locator('#iban').blur();
    await web.click('button[type=submit]');
    await web.waitForTimeout(800);
    expect(await web.textContent('#result')).toContain('Salvato: ACME srl / Consulenza');

    const stopped = await send(options, { action: 'stopRecordingCapture' });
    expect(stopped.success).toBe(true);
    const proc = stopped.procedure;
    expect(proc.steps.map((s: any) => s.type)).toEqual(['navigate', 'fill', 'click', 'click', 'fill', 'click', 'fill', 'click']);
    expect(proc.steps.filter((s: any) => s.thumbnail?.startsWith('data:image/jpeg')).length).toBeGreaterThan(0);
    expect(JSON.stringify(proc)).not.toContain('IT60X0542811101000000123456');
    expect(await web.evaluate(() => !!document.querySelector('[data-dommotion-recording]'))).toBe(false);

    // Run it on a fresh page through playwright-crx (chrome.debugger)
    const target = await context.newPage();
    await target.goto(`${base}/form.html`);
    await target.bringToFront();
    const tabId = await options.evaluate(async (url) => (await chrome.tabs.query({ url })).pop()?.id, `${base}/form.html`);
    const ibanParam = proc.params.find((p: any) => p.label === 'IBAN').name;
    const runRes = await send(options, { action: 'runProcedure', procedureId: proc.id, tabId, params: { [ibanParam]: 'IT02L1234512345123456789012' } });
    if (!runRes?.report || runRes.report.status !== 'success') console.log('RUN', JSON.stringify(runRes, null, 2));
    expect(runRes.report.status).toBe('success');
    expect(await target.textContent('#result')).toBe('Salvato: ACME srl / Consulenza / ');

    // The editor shows the procedure with its steps and run history
    await options.goto(`chrome-extension://${extId}/options.html#procedures/${proc.id}`);
    await options.reload();
    await options.waitForSelector('[data-testid="procedure-editor"]', { timeout: 10000 });
    expect(await options.locator('[data-testid^="step-"]').count()).toBe(proc.steps.length);
    await options.close();
  }, 120000);

  it('runs a full agent task against an OpenAI-compatible endpoint, then saves it as a procedure', async () => {
    const textOf = (m: any) => (typeof m.content === 'string' ? m.content : (m.content ?? []).map((p: any) => p.text ?? '').join('\n'));
    const ref = (messages: any[], label: string) => {
      const all = [...messages.map(textOf).join('\n').matchAll(new RegExp(`\\[(\\d+)\\] \\w+ "[^"]*${label}`, 'g'))];
      return Number(all[all.length - 1][1]);
    };
    let id = 0;
    const call = (name: string, args: Record<string, unknown>) => ({ index: id, id: `call_${++id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const llm = await mockLlmServer((body) => {
      if (!body.tools) return [{ content: 'ok' }];
      const msgs = body.messages;
      const turns = msgs.filter((m: any) => m.role === 'assistant' && m.tool_calls).length;
      id = 0;
      switch (turns) {
        case 0: return [{ content: 'Osservo la pagina.' }, { tool_calls: [call('browser_observe', {})] }];
        case 1: return [{ tool_calls: [
          call('browser_fill_ref', { ref: ref(msgs, 'Ragione sociale'), text: 'Agent srl' }),
          call('browser_fill_ref', { ref: ref(msgs, 'Partita IVA'), text: '09876543210' }),
          call('browser_select_ref', { ref: ref(msgs, 'Seleziona'), option: 'Servizi IT' }),
          call('browser_click_ref', { ref: ref(msgs, 'Pagamento') }),
        ] }];
        case 2: return [{ tool_calls: [
          call('browser_fill_ref', { ref: ref(msgs, 'IBAN'), text: 'IT02L1234512345123456789012' }),
          call('browser_select_ref', { ref: ref(msgs, 'Termini'), option: '30 giorni' }),
          call('browser_click_ref', { ref: ref(msgs, 'Salva') }),
        ] }];
        default: return [{ content: 'Fornitore Agent srl creato.' }];
      }
    });
    try {
      const ext = await context.newPage();
      await ext.goto(`chrome-extension://${extId}/options.html`);
      await ext.evaluate(async (base) => {
        await chrome.storage.sync.set({
          openaiCompatibleApiKey: 'test-key',
          openaiCompatibleBaseUrl: `${base}/v1`,
          modelProfiles: [{ id: 'p', name: 'mock', modelId: 'mock-model', contextWindowSize: 32000 }],
          defaultProfileId: 'p',
          approvalMode: 'off',
          planningEnabled: false,
        });
      }, llm.base);

      await ext.evaluate(() => {
        (window as any).__ui = [];
        chrome.runtime.onMessage.addListener((m: any) => { (window as any).__ui.push(m); });
      });
      const web = await context.newPage();
      await web.goto(`${base}/form.html?agent=1`);
      await web.bringToFront();
      const tabId = await ext.evaluate(async (url) => (await chrome.tabs.query({ url })).pop()?.id, `${base}/form.html?agent=1`);
      await send(ext, { action: 'executePrompt', prompt: 'Crea il fornitore Agent srl', tabId });
      try {
        await web.waitForFunction(() => document.getElementById('result')?.textContent?.startsWith('Salvato'), null, { timeout: 60000 });
      } catch (e) {
        console.log('LLM REQUESTS', llm.requests.length, JSON.stringify(llm.requests.map(r => ({ tools: !!r.tools, last: r.messages?.slice(-2) })), null, 1).slice(0, 6000));
        console.log('SW LOGS', swLogs.slice(-60).join('\n'));
        console.log('UI MESSAGES', JSON.stringify(await ext.evaluate(() => (window as any).__ui.map((m: any) => [m.action, typeof m.content === 'string' ? m.content : m.content?.content ?? m.content]))).slice(0, 8000));
        throw e;
      }
      expect(await web.textContent('#result')).toBe('Salvato: Agent srl / Servizi IT / 30');

      // Wait for the final answer turn
      for (let i = 0; i < 100 && llm.requests.filter(r => r.tools).length < 4; i++) await new Promise(r => setTimeout(r, 100));
      // The endpoint received real tool schemas and role:"tool" results
      const agentReqs = llm.requests.filter(r => r.tools);
      expect(agentReqs.length).toBe(4);
      expect(agentReqs[0].tools.map((t: any) => t.function.name)).toContain('browser_observe');
      expect(agentReqs[3].messages.filter((m: any) => m.role === 'tool')).toHaveLength(8);
      expect(textOf(agentReqs[3].messages[agentReqs[3].messages.length - 1])).toContain('[STATO');

      // Save the task as a procedure and replay it without the LLM
      await new Promise(r => setTimeout(r, 500));
      const saved = await send(ext, { action: 'saveTaskAsProcedure', tabId });
      expect(saved.success).toBe(true);
      expect(saved.procedure.source).toBe('agent');
      const fresh = await context.newPage();
      await fresh.goto(`${base}/form.html?replay=1`);
      const freshTab = await ext.evaluate(async (url) => (await chrome.tabs.query({ url })).pop()?.id, `${base}/form.html?replay=1`);
      const ibanParam = saved.procedure.params.find((p: any) => /iban/i.test(p.name))?.name;
      const before = llm.requests.length;
      const run = await send(ext, { action: 'runProcedure', procedureId: saved.procedure.id, tabId: freshTab, params: ibanParam ? { [ibanParam]: 'IT02L1234512345123456789012' } : {} });
      if (run?.report?.status !== 'success') console.log('REPLAY', JSON.stringify(run, null, 2));
      expect(run.report.status).toBe('success');
      expect(await fresh.textContent('#result')).toBe('Salvato: Agent srl / Servizi IT / 30');
      expect(llm.requests.length).toBe(before); // no LLM call during the replay
    } finally {
      llm.server.close();
    }
  }, 180000);

  it('renders the side panel with the procedure chips for the current site', async () => {
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.evaluate(() => chrome.storage.sync.set({ openaiCompatibleApiKey: 'x', openaiCompatibleBaseUrl: 'http://127.0.0.1:9/v1' }));
    await panel.reload();
    await panel.waitForSelector('[data-testid="quick-actions"]', { timeout: 15000 });
    await panel.click('[data-testid="btn-automate"]');
    await panel.waitForSelector('[data-testid="btn-start-recording"]');
    expect(errors.filter(e => !/Failed to load resource|net::ERR/.test(e))).toEqual([]);
    await panel.close();
  }, 60000);
});
