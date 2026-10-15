/**
 * @jest-environment node
 */
jest.mock('../../../src/agent/approvalManager', () => ({ requestApproval: jest.fn() }));
jest.mock('../../../src/background/tabManager', () => ({ getWindowForTab: () => 1 }));

import { ExecutionEngine, ExecutionCallbacks } from '../../../src/agent/ExecutionEngine';
import { ErrorHandler } from '../../../src/agent/ErrorHandler';
import { MemoryManager } from '../../../src/agent/MemoryManager';
import { resetPageContext, setCurrentPage } from '../../../src/agent/PageContextManager';
import { PromptManager } from '../../../src/agent/PromptManager';
import { ToolManager } from '../../../src/agent/ToolManager';
import { requestApproval } from '../../../src/agent/approvalManager';
import { _setCurrentMap } from '../../../src/agent/tools/pageMapTools';
import type { ChatMessage, LLMProvider, StreamChunk } from '../../../src/models/providers/types';

type Script = (req: { messages: ChatMessage[]; tools: any[]; n: number; system: string }) => StreamChunk[] | Error;

class Scripted implements LLMProvider {
  requests: Array<{ messages: ChatMessage[]; tools: any[]; system: string }> = [];
  summaries = 0;
  constructor(private script: Script) {}
  async *createMessage(system: string, messages: any[], tools?: any[]) {
    if (!/DomMotion/.test(system)) { this.summaries++; yield { type: 'text', text: 'SUMMARY' } as StreamChunk; return; }
    const req = { system, messages: JSON.parse(JSON.stringify(messages)), tools: tools ?? [] };
    this.requests.push(req);
    const out = this.script({ ...req, n: this.requests.length });
    if (out instanceof Error) throw out;
    for (const c of out) yield c;
  }
  getModel() { return { id: 'm', info: { name: 'm', inputPrice: 0, outputPrice: 0, contextWindow: 32000 } }; }
  getDefaultProfile() { return null; }
}

let id = 0;
const call = (name: string, args: Record<string, unknown> = {}): StreamChunk => ({ type: 'tool_call', toolCall: { id: `c${++id}`, name, arguments: JSON.stringify(args) } });
const text = (t: string): StreamChunk => ({ type: 'text', text: t });
const lastText = (m: ChatMessage[]) => {
  const c = m[m.length - 1].content;
  return typeof c === 'string' ? c : (c ?? []).map((p: any) => p.text ?? '[img]').join('\n');
};

function fakeTools(overrides: Record<string, (input: string) => Promise<any>> = {}) {
  const make = (name: string, fn: (input: string) => Promise<any>) => ({ name, description: name, func: jest.fn(fn) });
  const base: Record<string, (input: string) => Promise<any>> = {
    browser_observe: async () => 'Page: x\nInteractive elements (act with the [number]):\n[1] button "Salva"\n[2] button "Elimina tutto"',
    browser_click_ref: async (i) => `Clicked [${i}] · stable\nChanges:\nno visible changes`,
    browser_fill_ref: async (i) => `Filled ${i} · stable\nChanges:\n~ [3] textbox "Nome" = "x"`,
    browser_navigate: async (u) => `Navigated to ${u}\nInteractive elements (act with the [number]):\n[1] link "Home"`,
    browser_read_text: async () => 'testo della pagina',
    extract_with_schema: async () => '{"rows":[1,2,3]}',
    ...overrides,
  };
  return Object.entries(base).map(([n, f]) => make(n, f));
}

function setup(script: Script, opts: { tools?: any[]; contextWindowSize?: number; nativeToolCalling?: boolean } = {}) {
  const page: any = { url: () => 'https://erp.example.com/fornitori', title: async () => 'Fornitori', context: () => ({ pages: () => [1, 2] }), evaluate: jest.fn() };
  setCurrentPage(page);
  const tools = opts.tools ?? fakeTools();
  const provider = new Scripted(script);
  const engine = new ExecutionEngine(provider, new ToolManager(page, tools), new PromptManager(tools), new MemoryManager(), new ErrorHandler());
  engine.setActiveProfile({ id: 'p', name: 'p', modelId: 'm', contextWindowSize: opts.contextWindowSize ?? 32000, nativeToolCalling: opts.nativeToolCalling } as any);
  engine.setMinMsBetweenCalls(0);
  engine.setStepRetryDelayMs(1);
  const log: string[] = [];
  const finals: string[] = [];
  const cb: ExecutionCallbacks = {
    onLlmOutput: (s) => finals.push(s),
    onToolOutput: (s) => log.push(s),
    onComplete: () => log.push('COMPLETE'),
    onLlmChunk: () => undefined,
  };
  return { engine, provider, tools, log, finals, cb };
}

describe('ExecutionEngine', () => {
  beforeEach(() => { (requestApproval as jest.Mock).mockReset(); _setCurrentMap(null); });
  afterEach(() => resetPageContext());

  it('runs several native tool calls per turn and ends with one final answer', async () => {
    const { engine: e2, provider: p2, tools: t2, finals: f2, log: l2, cb } = setup(({ n }) =>
      n === 1 ? [text('Compilo.'), call('browser_fill_ref', { ref: 3, text: 'x' }), call('browser_read_text')] : [text('Fatto.')]);
    const result = await e2.executePrompt('Compila', cb, [], true);
    expect(result).toMatchObject({ outcome: 'success', finalText: 'Fatto.' });
    expect(result.stats).toMatchObject({ toolCalls: 2, toolErrors: 0, steps: 2, actions: 1 });
    expect((t2.find(t => t.name === 'browser_fill_ref')!.func as jest.Mock).mock.calls[0][0]).toBe('{"ref":3,"text":"x"}');
    const second = p2.requests[1].messages;
    const assistant = second.find(m => m.role === 'assistant')!;
    expect(assistant.tool_calls).toHaveLength(2);
    expect(second.filter(m => m.role === 'tool').map(m => m.tool_call_id)).toEqual(assistant.tool_calls!.map(c => c.id));
    expect(f2).toEqual(['Fatto.']);
    expect(l2.filter(l => l.startsWith('🕹️ tool:'))).toHaveLength(2);
  });

  it('puts URL, tabs and the live plan in the per-step [STATE] message', async () => {
    const { engine, provider, cb } = setup(({ n }) =>
      n === 1 ? [call('update_plan', { steps: [{ title: 'Apri fornitori', status: 'done' }, { title: 'Crea fornitore', status: 'doing' }] })] : [text('ok')]);
    await engine.executePrompt('Crea fornitore', cb, [], true);
    const state = lastText(provider.requests[1].messages);
    expect(state).toContain('[STATO — passo 2 di 60]');
    expect(state).toContain('Tab attivo: "Fornitori" — https://erp.example.com/fornitori (2 tab aperti)');
    expect(state).toContain('✓ 1. Apri fornitori');
    expect(state).toContain('→ 2. Crea fornitore');
  });

  it('asks approval for risky clicks (decided by the extension) and stops the batch when rejected', async () => {
    (requestApproval as jest.Mock).mockResolvedValue(false);
    _setCurrentMap({ url: 'https://erp.example.com', entries: [{ ref: 2, role: 'button', label: 'Elimina tutto', candidates: [] }] });
    const { engine, provider, tools, cb } = setup(({ n }) =>
      n === 1 ? [call('browser_click_ref', { ref: 2 }), call('browser_read_text')] : [text('Non ho eliminato nulla.')]);
    const result = await engine.executePrompt('Pulisci', cb, [], true);
    expect(requestApproval).toHaveBeenCalledWith(expect.any(Number), 'browser_click_ref', expect.any(String), expect.stringContaining('Elimina tutto'), undefined);
    expect(tools.find(t => t.name === 'browser_click_ref')!.func).not.toHaveBeenCalled();
    expect(tools.find(t => t.name === 'browser_read_text')!.func).not.toHaveBeenCalled();
    const results = provider.requests[1].messages.filter(m => m.role === 'tool').map(m => m.content as string);
    expect(results[0]).toContain('rejected by the user');
    expect(results[1]).toContain('rifiutato');
    expect(result.outcome).toBe('success');
  });

  it('does not ask approval for a plain "Salva" in risky mode', async () => {
    _setCurrentMap({ url: 'https://erp.example.com', entries: [{ ref: 1, role: 'button', label: 'Salva', candidates: [] }] });
    const { engine, cb } = setup(({ n }) => (n === 1 ? [call('browser_click_ref', { ref: 1 })] : [text('ok')]));
    await engine.executePrompt('Salva', cb, [], true);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('reports unknown tools with the list of available ones', async () => {
    const { engine, provider, cb } = setup(({ n }) => (n === 1 ? [call('browser_teleport', {})] : [text('ok')]));
    await engine.executePrompt('x', cb, [], true);
    const res = provider.requests[1].messages.find(m => m.role === 'tool')!.content as string;
    expect(res).toContain('tool "browser_teleport" does not exist');
    expect(res).toContain('browser_observe');
  });

  it('nudges after empty responses and fails after three in a row', async () => {
    const { engine, provider, cb } = setup(() => []);
    const result = await engine.executePrompt('x', cb, [], true);
    expect(result.outcome).toBe('failure');
    expect(provider.requests).toHaveLength(3);
    expect(lastText(provider.requests[1].messages)).toContain('risposta precedente era vuota');
  });

  it('switches to the XML protocol when the endpoint rejects tools, and parses several XML calls', async () => {
    const { engine, provider, tools, cb, log } = setup(({ tools: t, n }) => {
      if (t.length) return [{ type: 'error', error: { message: 'tools unsupported', toolsUnsupported: true } }];
      if (n === 2) return [text('Osservo\n<tool>browser_observe</tool>\n<input></input>\n<tool>browser_read_text</tool>\n<input></input>')];
      return [text('Finito')];
    });
    const result = await engine.executePrompt('x', cb, [], true);
    expect(result.finalText).toBe('Finito');
    expect(tools.find(t => t.name === 'browser_read_text')!.func).toHaveBeenCalled();
    expect(log.some(l => l.includes('protocollo testuale'))).toBe(true);
    // XML results are sent back as a user message, merged with the state
    expect(lastText(provider.requests[2].messages)).toContain('Risultato di browser_observe:');
  });

  it('uses the XML protocol from the start when the profile disables native tools', async () => {
    const { engine, provider, cb } = setup(() => [text('ok')], { nativeToolCalling: false });
    await engine.executePrompt('x', cb, [], true);
    expect(provider.requests[0].tools).toEqual([]);
    expect(provider.requests[0].system).toContain('<tool>nome_tool</tool>');
  });

  it('reports malformed XML calls back to the model', async () => {
    const { engine, provider, cb } = setup(({ n }) => (n === 1 ? [text('<tool>browser_observe <input>')] : [text('ok')]), { nativeToolCalling: false });
    await engine.executePrompt('x', cb, [], true);
    expect(lastText(provider.requests[1].messages)).toContain('Errore di formato');
  });

  it('retries transient LLM errors, then fails with a clear message', async () => {
    const { engine, provider, cb, finals } = setup(() => [{ type: 'error', error: { message: 'LLM request failed (status 502)' } }]);
    const result = await engine.executePrompt('x', cb, [], true);
    expect(provider.requests).toHaveLength(3);
    expect(result.outcome).toBe('failure');
    expect(finals[0]).toContain('502');
  });

  it('stops at maxSteps with the plan status', async () => {
    const { engine, cb } = setup(() => [call('browser_read_text')]);
    const result = await engine.executePrompt('x', cb, [], true, { maxSteps: 3, initialPlan: [{ title: 'Leggi', status: 'doing' }] });
    expect(result.outcome).toBe('maxSteps');
    expect(result.finalText).toContain('Mi sono fermato dopo 3 passi');
    expect(result.finalText).toContain('Leggi [doing]');
  });

  it('stops repeated identical actions without progress (loop detection)', async () => {
    const { engine, provider, cb } = setup(() => [call('browser_click_ref', { ref: 1 })]);
    const result = await engine.executePrompt('x', cb, [], true);
    expect(result.outcome).toBe('failure');
    expect(provider.requests.length).toBe(5);
    expect(lastText(provider.requests[3].messages)).toContain('Hai ripetuto browser_click_ref');
  });

  it('turns tool timeouts into errors instead of hanging', async () => {
    const tools = fakeTools({ browser_read_text: () => new Promise(() => undefined) });
    const { engine, provider, cb } = setup(({ n }) => (n === 1 ? [call('browser_read_text')] : [text('ok')]), { tools });
    (engine as any).configManager = { getToolTimeoutMs: async () => 20, getNavigationTimeoutMs: async () => 20, getApprovalMode: async () => 'risky', getAdvancedToolsEnabled: async () => false };
    await engine.executePrompt('x', cb, [], true);
    expect(provider.requests[1].messages.find(m => m.role === 'tool')!.content).toContain('timed out');
  });

  it('keeps only the latest observation of each kind in full', async () => {
    const big = 'x'.repeat(9000);
    const tools = fakeTools({ browser_read_text: async () => `testo ${big}` });
    const { engine, provider, cb } = setup(({ n }) => (n <= 6 ? [call('browser_read_text')] : [text('ok')]), { tools, contextWindowSize: 16000 });
    await engine.executePrompt('Leggi tutto', cb, [], true);
    const last = provider.requests[provider.requests.length - 1].messages;
    const toolMsgs = last.filter(m => m.role === 'tool').map(m => m.content as string);
    expect(toolMsgs).toHaveLength(6);
    expect(toolMsgs.slice(0, 5).every(t => t.startsWith('[Superseded by a newer observation] testo'))).toBe(true);
    expect(toolMsgs[5]).toBe(`testo ${big}`);
    expect(provider.summaries).toBe(0);
  });

  it('summarizes the oldest turns when the context still exceeds the budget', async () => {
    const big = JSON.stringify({ rows: 'y'.repeat(12000) });
    const tools = fakeTools({ extract_with_schema: async () => big });
    // Different hints: not a loop, just a long extraction task
    const { engine, provider, cb } = setup(({ n }) => (n <= 7 ? [call('extract_with_schema', { schema: { type: 'object' }, hint: `pagina ${n}` })] : [text('ok')]), { tools, contextWindowSize: 16000 });
    await engine.executePrompt('Estrai', cb, [], true);
    expect(provider.summaries).toBeGreaterThan(0);
    const last = provider.requests[provider.requests.length - 1].messages;
    expect(lastText([last[0]])).toContain('[Riepilogo dei passi già svolti in questo task]');
    expect(lastText([last[0]])).toContain('SUMMARY');
    expect(last.filter(m => m.role === 'tool').length).toBeLessThanOrEqual(4);
  });

  it('honours cancellation', async () => {
    const errorHandler = new ErrorHandler();
    const { engine, cb } = setup(() => [call('browser_read_text')]);
    (engine as any).errorHandler = errorHandler;
    const tools = (engine as any).toolManager.getTools();
    tools.find((t: any) => t.name === 'browser_read_text').func = jest.fn(async () => { errorHandler.cancel(); return 'testo'; });
    const result = await engine.executePrompt('x', cb, [], true);
    expect(result.outcome).toBe('cancelled');
  });

  it('adds memory/procedure hints to the task and strips tool debris from previous tasks', async () => {
    const { engine, provider, cb } = setup(() => [text('ok')]);
    await engine.executePrompt('nuovo', cb, [
      { role: 'user', content: 'vecchio' },
      { role: 'assistant', content: '<tool>browser_observe</tool><input></input>' },
      { role: 'assistant', content: 'risposta' },
      { role: 'user', content: 'nuovo' },
    ], true, { taskHints: ['Procedure salvate per questo sito: - "Crea fornitore"'] });
    const msgs = provider.requests[0].messages;
    expect(msgs.map(m => m.content)).toEqual(expect.arrayContaining(['vecchio', 'risposta']));
    expect(JSON.stringify(msgs)).not.toContain('<tool>');
    expect(msgs.find(m => typeof m.content === 'string' && m.content.startsWith('nuovo'))!.content).toContain('Crea fornitore');
  });

  it('aborts an in-flight LLM request when the task is stopped', async () => {
    const errorHandler = new ErrorHandler();
    let aborted = false;
    const provider: LLMProvider = {
      async *createMessage(_s: string, _m: any[], _t?: any[], _p?: any, _o?: any, signal?: AbortSignal) {
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => { aborted = true; resolve(); }));
        yield { type: 'error', error: { message: 'Request was aborted.' } } as StreamChunk;
      },
      getModel: () => ({ id: 'm', info: { name: 'm', inputPrice: 0, outputPrice: 0 } }),
      getDefaultProfile: () => null,
    };
    const page: any = { url: () => 'https://a.it', title: async () => 'A', context: () => ({ pages: () => [1] }) };
    setCurrentPage(page);
    const tools = fakeTools();
    const engine = new ExecutionEngine(provider, new ToolManager(page, tools), new PromptManager(tools), new MemoryManager(), errorHandler);
    engine.setMinMsBetweenCalls(0);
    const run = engine.executePrompt('x', { onLlmOutput: () => undefined, onToolOutput: () => undefined, onComplete: () => undefined }, [], true);
    await new Promise(r => setTimeout(r, 20));
    errorHandler.cancel();
    const result = await run;
    expect(aborted).toBe(true);
    expect(result.outcome).toBe('cancelled');
  });

  it('does not undo a Stop pressed before the run started', async () => {
    const { engine, provider, cb } = setup(() => [call('browser_read_text')]);
    (engine as any).errorHandler.cancel();
    const result = await engine.executePrompt('x', cb, [], true);
    expect(result.outcome).toBe('cancelled');
    expect(provider.requests).toHaveLength(0);
  });
});
