/**
 * @jest-environment node
 */
import type { Browser } from 'playwright-core';

jest.mock('../../src/background/tabManager', () => ({ getWindowForTab: () => 1 }));

import { ExecutionEngine, ExecutionCallbacks } from '../../src/agent/ExecutionEngine';
import { ErrorHandler } from '../../src/agent/ErrorHandler';
import { MemoryManager } from '../../src/agent/MemoryManager';
import { setCurrentPage, resetPageContext } from '../../src/agent/PageContextManager';
import { PromptManager } from '../../src/agent/PromptManager';
import { ToolManager } from '../../src/agent/ToolManager';
import { browserNavigate } from '../../src/agent/tools/navigationTools';
import { browserReadText, browserScreenshot } from '../../src/agent/tools/observationTools';
import { browserPressKey } from '../../src/agent/tools/keyboardTools';
import {
  browserObserve, browserClickRef, browserFillRef, browserSelectRef, browserScroll, _setCurrentMap,
} from '../../src/agent/tools/pageMapTools';
import type { ChatMessage, LLMProvider, ModelProfile, StreamChunk } from '../../src/models/providers/types';
import { describeIfChromium, launch, openFixture } from './helpers';

type Script = (req: { system: string; messages: ChatMessage[]; tools: any[]; n: number }) => StreamChunk[];

class ScriptedProvider implements LLMProvider {
  requests: Array<{ system: string; messages: ChatMessage[]; tools: any[] }> = [];
  constructor(private script: Script) {}
  async *createMessage(system: string, messages: any[], tools?: any[]) {
    // Summarizer / planner calls have no tools and a different system prompt
    if (!/DomMotion/.test(system)) {
      yield { type: 'text', text: 'riassunto dei passi precedenti' } as StreamChunk;
      return;
    }
    const req = { system, messages: JSON.parse(JSON.stringify(messages)), tools: tools ?? [] };
    this.requests.push(req);
    for (const c of this.script({ ...req, n: this.requests.length })) yield c;
  }
  getModel() { return { id: 'scripted', info: { name: 'scripted', inputPrice: 0, outputPrice: 0, contextWindow: 32000 } }; }
  getDefaultProfile() { return null; }
}

const textOf = (m: ChatMessage) => typeof m.content === 'string'
  ? m.content
  : (m.content ?? []).map(p => (p.type === 'text' ? p.text : '[image]')).join('\n');
const allText = (messages: ChatMessage[]) => messages.map(textOf).join('\n');
function ref(messages: ChatMessage[], label: string): number {
  const re = new RegExp(`\\[(\\d+)\\] \\w+ "[^"]*${label}`, 'g');
  const all = [...allText(messages).matchAll(re)];
  if (!all.length) throw new Error(`ref for ${label} not found`);
  return Number(all[all.length - 1][1]);
}
let callId = 0;
const call = (name: string, args: Record<string, unknown>): StreamChunk =>
  ({ type: 'tool_call', toolCall: { id: `c${++callId}`, name, arguments: JSON.stringify(args) } });
const text = (t: string): StreamChunk => ({ type: 'text', text: t });

function callbacks(log: string[] = []): ExecutionCallbacks {
  return {
    onLlmOutput: (s) => log.push(`FINAL ${s}`),
    onToolOutput: (s) => log.push(s),
    onComplete: () => log.push('COMPLETE'),
  };
}

function engineFor(page: any, provider: LLMProvider, profile: Partial<ModelProfile> = {}) {
  const tools = [
    browserObserve(page), browserClickRef(page), browserFillRef(page), browserSelectRef(page), browserScroll(page),
    browserNavigate(page), browserReadText(page), browserPressKey(page), browserScreenshot(page),
  ];
  const tm = new ToolManager(page, tools as any);
  const engine = new ExecutionEngine(provider, tm, new PromptManager(tools as any), new MemoryManager(), new ErrorHandler());
  engine.setActiveProfile({ id: 'p', name: 'p', modelId: 'scripted', contextWindowSize: 32000, ...profile } as ModelProfile);
  engine.setMinMsBetweenCalls(0);
  engine.setStepRetryDelayMs(10);
  return engine;
}

describeIfChromium('ExecutionEngine on real Chromium with a scripted model', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launch(); }, 30000);
  afterAll(async () => { await browser?.close(); });
  afterEach(() => { resetPageContext(); _setCurrentMap(null); });

  it('completes a multi-tab form with several native tool calls per turn', async () => {
    const page = await openFixture(browser, 'form.html') as any;
    setCurrentPage(page);
    const provider = new ScriptedProvider(({ messages, n }) => {
      switch (n) {
        case 1: return [text('Osservo la pagina.'), call('browser_observe', {})];
        case 2: return [
          call('browser_fill_ref', { ref: ref(messages, 'Ragione sociale'), text: 'ACME srl' }),
          call('browser_fill_ref', { ref: ref(messages, 'Partita IVA'), text: '01234567890' }),
          call('browser_select_ref', { ref: ref(messages, 'Seleziona'), option: 'Servizi IT' }),
          call('browser_click_ref', { ref: ref(messages, 'Pagamento') }),
        ];
        case 3: return [
          call('browser_fill_ref', { ref: ref(messages, 'IBAN'), text: 'IT60X0542811101000000123456' }),
          call('browser_select_ref', { ref: ref(messages, 'Termini'), option: '30 giorni' }),
          call('browser_click_ref', { ref: ref(messages, 'Salva') }),
        ];
        default: return [text('Fornitore salvato correttamente.')];
      }
    });
    const log: string[] = [];
    const result = await engineFor(page, provider).executePrompt('Crea il fornitore ACME', callbacks(log), [], true);
    expect(result.outcome).toBe('success');
    expect(result.finalText).toBe('Fornitore salvato correttamente.');
    expect(await page.textContent('#result')).toBe('Salvato: ACME srl / Servizi IT / 30');
    expect(provider.requests).toHaveLength(4);
    // Native protocol: tools sent as schemas, results as role:"tool" messages
    expect(provider.requests[0].tools.map((t: any) => t.name)).toContain('browser_observe');
    expect(provider.requests[0].tools.find((t: any) => t.name === 'browser_fill_ref').inputSchema.required).toEqual(['ref', 'text']);
    const last = provider.requests[3].messages;
    expect(last.filter(m => m.role === 'tool')).toHaveLength(8);
    // State message every step, static system prompt
    expect(textOf(last[last.length - 1])).toMatch(/\[STATO — passo 4 di \d+\]/);
    expect(provider.requests[0].system).toBe(provider.requests[3].system);
    expect(log.filter(l => l.startsWith('FINAL'))).toHaveLength(1);
  }, 60000);

  it('sends the Set-of-Marks screenshot to vision models as an image part', async () => {
    const page = await openFixture(browser, 'form.html') as any;
    setCurrentPage(page);
    const provider = new ScriptedProvider(({ n }) => (n === 1 ? [call('browser_observe', {})] : [text('Vedo il form.')]));
    const result = await engineFor(page, provider, { supportsImages: true }).executePrompt('Cosa vedi?', callbacks(), [], true);
    expect(result.outcome).toBe('success');
    const lastMsg = provider.requests[1].messages[provider.requests[1].messages.length - 1];
    expect(Array.isArray(lastMsg.content)).toBe(true);
    const image = (lastMsg.content as any[]).find(p => p.type === 'image_url');
    expect(image.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(provider.requests[0].tools.map((t: any) => t.name)).toContain('browser_screenshot');
  }, 60000);

  it('compacts superseded observations instead of keeping every page dump', async () => {
    const page = await openFixture(browser, 'long.html') as any;
    setCurrentPage(page);
    const provider = new ScriptedProvider(({ n }) => {
      if (n <= 3) return [call('browser_scroll', { direction: 'down' })];
      return [text('fine')];
    });
    await engineFor(page, provider).executePrompt('Scorri', callbacks(), [], true);
    const msgs = provider.requests[3].messages.filter(m => m.role === 'tool').map(textOf);
    expect(msgs[0]).toMatch(/^\[Superseded by a newer observation\]/);
    expect(msgs[1]).toMatch(/^\[Superseded by a newer observation\]/);
    expect(msgs[2]).toContain('Interactive elements (act with the [number])');
  }, 60000);

  it('detects a loop, warns, then stops with a failure', async () => {
    const page = await openFixture(browser, 'modal.html') as any;
    setCurrentPage(page);
    const provider = new ScriptedProvider(({ messages, n }) => {
      if (n === 1) return [call('browser_observe', {})];
      return [call('browser_click_ref', { ref: ref(messages, 'Link sotto') })];
    });
    const result = await engineFor(page, provider).executePrompt('Clicca', callbacks(), [], true);
    expect(result.outcome).toBe('failure');
    expect(result.finalText).toMatch(/Mi sono fermato/);
    const warned = provider.requests.some(r => /Hai ripetuto browser_click_ref/.test(textOf(r.messages[r.messages.length - 1])));
    expect(warned).toBe(true);
    expect(provider.requests.length).toBeLessThanOrEqual(7);
  }, 60000);

  it('falls back to the XML text protocol when the endpoint rejects tools', async () => {
    const page = await openFixture(browser, 'form.html') as any;
    setCurrentPage(page);
    const provider = new ScriptedProvider(({ tools, messages, n }) => {
      if (tools.length) return [{ type: 'error', error: { status: 400, message: 'tools not supported', toolsUnsupported: true } }];
      if (n === 2) return [text('<tool>browser_observe</tool>\n<input></input>')];
      if (n === 3) return [text(`<tool>browser_fill_ref</tool>\n<input>{"ref": ${ref(messages, 'Ragione sociale')}, "text": "XML srl"}</input>`)];
      return [text('Fatto.')];
    });
    const log: string[] = [];
    const result = await engineFor(page, provider).executePrompt('Compila', callbacks(log), [], true);
    expect(result.outcome).toBe('success');
    expect(await page.inputValue('#rs')).toBe('XML srl');
    expect(log.some(l => /protocollo testuale/.test(l))).toBe(true);
    expect(provider.requests[1].system).toContain('<tool>nome_tool</tool>');
  }, 60000);

  it('keeps only requests and final answers from previous tasks', async () => {
    const page = await openFixture(browser, 'form.html') as any;
    setCurrentPage(page);
    const provider = new ScriptedProvider(() => [text('ok')]);
    const history = [
      { role: 'user', content: 'compito precedente' },
      { role: 'assistant', content: '<tool>browser_observe</tool><input></input>' },
      { role: 'assistant', content: 'risposta finale precedente' },
    ];
    await engineFor(page, provider).executePrompt('nuovo compito', callbacks(), history, true);
    const sent = provider.requests[0].messages;
    expect(allText(sent)).not.toContain('<tool>');
    expect(allText(sent)).toContain('risposta finale precedente');
  }, 30000);
});
