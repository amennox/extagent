import { OpenAICompatibleProvider, OpenAICompatibleProviderOptions, isContextOverflowError, isToolsUnsupportedError, ThinkTagFilter, stripThinkTags } from '../../../../src/models/providers/openai-compatible';
import { ModelProfile, migrateProfile } from '../../../../src/models/providers/types';

let capturedRequestBody: any = null;
let mockStreamChunks: any[] = [];
let mockCreateError: any = null;

jest.mock('openai', () => {
  const MockOpenAI = jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: jest.fn().mockImplementation(async (body: any) => {
          capturedRequestBody = body;
          if (mockCreateError) throw mockCreateError;
          const chunks = mockStreamChunks;
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        }),
      },
    },
  }));
  return { __esModule: true, default: MockOpenAI };
});

const baseOptions: OpenAICompatibleProviderOptions = {
  apiKey: 'test-key',
  baseUrl: 'http://localhost:8000/v1',
  apiModelId: 'qwen3-35b',
  openaiCompatibleModels: [
    { id: 'qwen3-35b', name: 'Qwen3 35B' },
    { id: 'qwen3-7b', name: 'Qwen3 7B' },
  ],
};

const reasoningProfile: ModelProfile = {
  id: 'thinking',
  name: 'Qwen3 Thinking',
  modelId: 'qwen3-35b',
  reasoningEffort: 'medium',
  maxTokens: 16384,
  temperature: 0.5,
};

const fastProfile: ModelProfile = {
  id: 'fast',
  name: 'Qwen3 Fast',
  modelId: 'qwen3-35b',
  maxTokens: 4096,
  temperature: 0,
};

async function drainStream(stream: AsyncIterable<any>) {
  for await (const _ of stream) { /* drain */ }
}

async function collectStream(stream: AsyncIterable<any>) {
  const out: any[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

function contentChunk(content: string) {
  return { choices: [{ delta: { content } }] };
}

describe('OpenAICompatibleProvider - request body standard OpenAI', () => {
  beforeEach(() => { capturedRequestBody = null; mockStreamChunks = []; });

  it('include reasoning_effort quando il profilo lo definisce', async () => {
    const provider = new OpenAICompatibleProvider(baseOptions);
    await drainStream(provider.createMessage('sys', [], [], reasoningProfile));
    expect(capturedRequestBody.reasoning_effort).toBe('medium');
  });

  it('disabilita il thinking (enable_thinking=false) quando il reasoning è off', async () => {
    const provider = new OpenAICompatibleProvider(baseOptions);
    await drainStream(provider.createMessage('sys', [], [], fastProfile));
    expect(capturedRequestBody.reasoning_effort).toBeUndefined();
    // Deve essere esplicitamente false: Qwen3 locale altrimenti ragiona di default
    expect(capturedRequestBody.enable_thinking).toBe(false);
    expect(capturedRequestBody.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(capturedRequestBody.thinking_budget).toBeUndefined();
  });

  it('abilita il thinking (enable_thinking=true + chat_template_kwargs) quando reasoning on', async () => {
    const provider = new OpenAICompatibleProvider(baseOptions);
    await drainStream(provider.createMessage('sys', [], [], reasoningProfile));
    expect(capturedRequestBody.enable_thinking).toBe(true);
    expect(capturedRequestBody.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it('rispetta una temperature positiva del profilo anche con reasoning on', async () => {
    const provider = new OpenAICompatibleProvider(baseOptions);
    await drainStream(provider.createMessage('sys', [], [], reasoningProfile));
    expect(capturedRequestBody.temperature).toBe(0.5);
  });

  it('evita il greedy (temp 0.6) quando reasoning on e temperature del profilo è 0', async () => {
    const provider = new OpenAICompatibleProvider(baseOptions);
    const p: ModelProfile = { ...reasoningProfile, temperature: 0 };
    await drainStream(provider.createMessage('sys', [], [], p));
    expect(capturedRequestBody.temperature).toBe(0.6);
  });

  it('invia sia max_completion_tokens sia max_tokens (compat server locali)', async () => {
    const provider = new OpenAICompatibleProvider(baseOptions);
    await drainStream(provider.createMessage('sys', [], [], fastProfile));
    expect(capturedRequestBody.max_completion_tokens).toBe(4096);
    expect(capturedRequestBody.max_tokens).toBe(4096);
  });

  it('migra il legacy enableThinking=true in reasoning_effort=medium', async () => {
    const legacy: ModelProfile = { ...fastProfile, enableThinking: true };
    const provider = new OpenAICompatibleProvider(baseOptions);
    await drainStream(provider.createMessage('sys', [], [], legacy));
    expect(capturedRequestBody.reasoning_effort).toBe('medium');
    expect(capturedRequestBody.enable_thinking).toBe(true);
  });

  it('unisce extraBody nel request body (escape hatch)', async () => {
    const profile: ModelProfile = {
      ...fastProfile,
      extraBody: '{"chat_template_kwargs": {"enable_thinking": false}}',
    };
    const provider = new OpenAICompatibleProvider(baseOptions);
    await drainStream(provider.createMessage('sys', [], [], profile));
    expect(capturedRequestBody.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('ignora extraBody con JSON non valido', async () => {
    const profile: ModelProfile = { ...fastProfile, extraBody: '{not json' };
    const provider = new OpenAICompatibleProvider(baseOptions);
    await drainStream(provider.createMessage('sys', [], [], profile));
    expect(capturedRequestBody.model).toBe('qwen3-35b');
  });

  it('applica i requestOverrides per singola chiamata (es. response_format)', async () => {
    const provider = new OpenAICompatibleProvider(baseOptions);
    await drainStream(provider.createMessage('sys', [], [], fastProfile, { response_format: { type: 'json_object' } }));
    expect(capturedRequestBody.response_format).toEqual({ type: 'json_object' });
  });
});

describe('migrateProfile', () => {
  it('converte enableThinking=true in reasoningEffort=medium', () => {
    const p = migrateProfile({ id: 'x', name: 'x', modelId: 'm', enableThinking: true });
    expect(p.reasoningEffort).toBe('medium');
  });

  it('non tocca un profilo con reasoningEffort già impostato', () => {
    const p = migrateProfile({ id: 'x', name: 'x', modelId: 'm', enableThinking: true, reasoningEffort: 'high' });
    expect(p.reasoningEffort).toBe('high');
  });

  it('lascia il reasoning off se enableThinking=false', () => {
    const p = migrateProfile({ id: 'x', name: 'x', modelId: 'm', enableThinking: false });
    expect(p.reasoningEffort).toBeUndefined();
  });
});

describe('Gestione reasoning dual-mode (Galene)', () => {
  beforeEach(() => { capturedRequestBody = null; mockStreamChunks = []; });

  it('emette reasoning_content come chunk reasoning, mai come text', async () => {
    mockStreamChunks = [
      { choices: [{ delta: { reasoning_content: 'sto pensando' } }] },
      contentChunk('Risposta finale'),
    ];
    const provider = new OpenAICompatibleProvider(baseOptions);
    const chunks = await collectStream(provider.createMessage('sys', [], [], fastProfile));
    const texts = chunks.filter(c => c.type === 'text').map(c => c.text).join('');
    const reasonings = chunks.filter(c => c.type === 'reasoning').map(c => c.reasoning).join('');
    expect(texts).toBe('Risposta finale');
    expect(reasonings).toBe('sto pensando');
  });

  it('filtra silenziosamente i tag <think> inline nel content', async () => {
    mockStreamChunks = [
      contentChunk('<think>ragionamento nascosto</think>Ciao!'),
    ];
    const provider = new OpenAICompatibleProvider(baseOptions);
    const chunks = await collectStream(provider.createMessage('sys', [], [], fastProfile));
    const texts = chunks.filter(c => c.type === 'text').map(c => c.text).join('');
    expect(texts).toBe('Ciao!');
    expect(texts).not.toContain('<think>');
  });

  it('gestisce tag <think> spezzati su più chunk', async () => {
    mockStreamChunks = [
      contentChunk('<thi'),
      contentChunk('nk>ragiono...</th'),
      contentChunk('ink>Risposta'),
    ];
    const provider = new OpenAICompatibleProvider(baseOptions);
    const chunks = await collectStream(provider.createMessage('sys', [], [], fastProfile));
    const texts = chunks.filter(c => c.type === 'text').map(c => c.text).join('');
    expect(texts).toBe('Risposta');
  });

  it('recupera la tool call se il modello la mette nel canale reasoning', async () => {
    // Alcuni endpoint instradano l'intera risposta (tool call inclusa) in reasoning_content
    mockStreamChunks = [
      { choices: [{ delta: { reasoning_content: 'Devo cliccare. <tool>browser_click</tool><input>#btn</input><requires_approval>false</requires_approval>' } }] },
    ];
    const provider = new OpenAICompatibleProvider(baseOptions);
    const chunks = await collectStream(provider.createMessage('sys', [], [], fastProfile));
    const texts = chunks.filter(c => c.type === 'text').map(c => c.text).join('');
    expect(texts).toContain('<tool>browser_click</tool>');
  });

  it('recupera la tool call da un blocco <think> mai chiuso (troncamento)', async () => {
    mockStreamChunks = [
      contentChunk('<think>ragiono e poi <tool>browser_click</tool><input>#x</input><requires_approval>false</requires_approval>'),
    ];
    const provider = new OpenAICompatibleProvider(baseOptions);
    const chunks = await collectStream(provider.createMessage('sys', [], [], fastProfile));
    const texts = chunks.filter(c => c.type === 'text').map(c => c.text).join('');
    expect(texts).toContain('<tool>browser_click</tool>');
  });

  it('non altera tool call XML nel content (nessun falso positivo su <tool>)', async () => {
    mockStreamChunks = [
      contentChunk('<think>uso il tool</think><tool>browser_click</tool><input>#btn</input><requires_approval>false</requires_approval>'),
    ];
    const provider = new OpenAICompatibleProvider(baseOptions);
    const chunks = await collectStream(provider.createMessage('sys', [], [], fastProfile));
    const texts = chunks.filter(c => c.type === 'text').map(c => c.text).join('');
    expect(texts).toBe('<tool>browser_click</tool><input>#btn</input><requires_approval>false</requires_approval>');
  });
});

describe('ThinkTagFilter (unit)', () => {
  it('passa testo senza tag inalterato', () => {
    const f = new ThinkTagFilter();
    const r = f.push('solo testo normale');
    const rest = f.flush();
    expect(r.text + rest.text).toBe('solo testo normale');
    expect(r.reasoning).toBe('');
  });

  it('gestisce più blocchi think nello stesso stream', () => {
    const f = new ThinkTagFilter();
    const r = f.push('A<think>x</think>B<think>y</think>C');
    expect(r.text).toBe('ABC');
    expect(r.reasoning).toBe('xy');
  });

  it('flush emette come reasoning se lo stream termina dentro un blocco think', () => {
    const f = new ThinkTagFilter();
    const r = f.push('<think>incompleto');
    const rest = f.flush();
    expect(r.text).toBe('');
    expect(rest.text).toBe('');
    expect((r.reasoning + rest.reasoning)).toBe('incompleto');
  });

  it('non trattiene indefinitamente testo che somiglia a un tag', () => {
    const f = new ThinkTagFilter();
    const r1 = f.push('valore <thin');
    const r2 = f.push('g> normale');
    const rest = f.flush();
    expect(r1.text + r2.text + rest.text).toBe('valore <thing> normale');
  });
});

describe('stripThinkTags', () => {
  it('rimuove i blocchi think dal testo accumulato', () => {
    expect(stripThinkTags('<think>a\nb</think>Risultato')).toBe('Risultato');
  });
});

describe('OpenAICompatibleProvider - tool schema', () => {
  beforeEach(() => { capturedRequestBody = null; });

  it('mappa tool con il loro inputSchema reale', async () => {
    const provider = new OpenAICompatibleProvider(baseOptions);
    const tools = [{
      name: 'browser_click',
      description: 'Click on an element',
      inputSchema: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
      },
    }];
    await drainStream(provider.createMessage('sys', [], tools, fastProfile));
    expect(capturedRequestBody.tools[0].function.parameters.properties.selector).toBeDefined();
    expect(capturedRequestBody.tools[0].function.parameters.properties.input).toBeUndefined();
  });

  it('usa fallback {input:string} se inputSchema non presente', async () => {
    const provider = new OpenAICompatibleProvider(baseOptions);
    const tools = [{ name: 'my_tool', description: 'A tool' }];
    await drainStream(provider.createMessage('sys', [], tools, fastProfile));
    expect(capturedRequestBody.tools[0].function.parameters.properties.input).toBeDefined();
  });

  it('include name e description del tool', async () => {
    const provider = new OpenAICompatibleProvider(baseOptions);
    const tools = [{ name: 'browser_screenshot', description: 'Take a screenshot' }];
    await drainStream(provider.createMessage('sys', [], tools, fastProfile));
    expect(capturedRequestBody.tools[0].function.name).toBe('browser_screenshot');
    expect(capturedRequestBody.tools[0].function.description).toBe('Take a screenshot');
  });

  it('restituisce array vuoto se tools non forniti', async () => {
    const provider = new OpenAICompatibleProvider(baseOptions);
    await drainStream(provider.createMessage('sys', [], undefined, fastProfile));
    expect(capturedRequestBody.tools).toBeUndefined();
  });
});

describe('OpenAICompatibleProvider - getDefaultProfile()', () => {
  it('restituisce il profilo con id=defaultProfileId', () => {
    const provider = new OpenAICompatibleProvider({
      ...baseOptions,
      profiles: [reasoningProfile, fastProfile],
      defaultProfileId: 'fast',
    });
    expect(provider.getDefaultProfile()?.id).toBe('fast');
  });

  it('restituisce il primo profilo se defaultProfileId non matcha', () => {
    const provider = new OpenAICompatibleProvider({
      ...baseOptions,
      profiles: [reasoningProfile, fastProfile],
      defaultProfileId: 'non-existent',
    });
    expect(provider.getDefaultProfile()?.id).toBe('thinking');
  });

  it('restituisce null se profiles è vuoto', () => {
    const provider = new OpenAICompatibleProvider({ ...baseOptions, profiles: [] });
    expect(provider.getDefaultProfile()).toBeNull();
  });
});

describe('OpenAICompatibleProvider - getModel()', () => {
  it('restituisce dati dal profilo default quando profiles configurati', () => {
    const provider = new OpenAICompatibleProvider({
      ...baseOptions,
      profiles: [reasoningProfile],
      defaultProfileId: 'thinking',
    });
    const model = provider.getModel();
    expect(model.id).toBe('qwen3-35b');
    expect(model.info.name).toBe('Qwen3 Thinking');
  });

  it('restituisce il modello configurato tramite apiModelId (legacy)', () => {
    const provider = new OpenAICompatibleProvider(baseOptions);
    const model = provider.getModel();
    expect(model.id).toBe('qwen3-35b');
    expect(model.info.name).toBe('Qwen3 35B');
  });

  it('fallback al primo modello se apiModelId non matcha (legacy)', () => {
    const provider = new OpenAICompatibleProvider({ ...baseOptions, apiModelId: 'non-existent-model' });
    const model = provider.getModel();
    expect(model.id).toBe('qwen3-35b');
  });

  it('usa fallback id se openaiCompatibleModels è vuoto (legacy)', () => {
    const provider = new OpenAICompatibleProvider({ ...baseOptions, apiModelId: 'my-custom-model', openaiCompatibleModels: [] });
    const model = provider.getModel();
    expect(model.id).toBe('my-custom-model');
  });

  it('usa gpt-3.5-turbo come fallback se nessun modello e nessun apiModelId', () => {
    const provider = new OpenAICompatibleProvider({ ...baseOptions, apiModelId: undefined, openaiCompatibleModels: [] });
    const model = provider.getModel();
    expect(model.id).toBe('gpt-3.5-turbo');
  });
});

describe('isContextOverflowError', () => {
  it('ritorna true per status 413', () => {
    expect(isContextOverflowError({ status: 413, message: 'Payload Too Large' })).toBe(true);
  });

  it('non tratta ogni 422 come overflow (solo con parole chiave)', () => {
    expect(isContextOverflowError({ status: 422, message: 'Unprocessable Entity' })).toBe(false);
    expect(isContextOverflowError({ status: 422, message: 'prompt is too long for this model' })).toBe(true);
  });

  it('riconosce gli overflow 400 di OpenAI, vLLM e llama.cpp', () => {
    expect(isContextOverflowError({ status: 400, code: 'context_length_exceeded', message: 'This model\'s maximum context length is 8192 tokens' })).toBe(true);
    expect(isContextOverflowError({ status: 400, message: "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens" })).toBe(true);
    expect(isContextOverflowError({ status: 400, error: { code: 'exceed_context_size_error' }, message: 'the request exceeds the available context size' })).toBe(true);
    expect(isContextOverflowError({ status: 400, message: 'invalid temperature' })).toBe(false);
  });

  it('ritorna true per status 500 con messaggio context_length', () => {
    expect(isContextOverflowError({ status: 500, message: 'context_length exceeded' })).toBe(true);
  });

  it('ritorna true per status 500 con messaggio too many tokens', () => {
    expect(isContextOverflowError({ status: 500, message: 'too many tokens in request' })).toBe(true);
  });

  it('ritorna false per status 500 senza parole chiave', () => {
    expect(isContextOverflowError({ status: 500, message: 'Internal Server Error' })).toBe(false);
  });

  it('ritorna false per errore generico senza status', () => {
    expect(isContextOverflowError(new Error('Network error'))).toBe(false);
  });
});


describe('OpenAICompatibleProvider - native tool calls and errors', () => {
  afterEach(() => { mockCreateError = null; });

  it('emits accumulated native tool calls as structured chunks (not XML text)', async () => {
    mockStreamChunks = [
      { choices: [{ delta: { content: 'Compilo.' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'browser_fill_ref', arguments: '{"ref":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' 3, "text": "x"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'browser_click_ref', arguments: '{"ref": 9}' } }] } }] },
    ];
    const provider = new OpenAICompatibleProvider(baseOptions);
    const chunks = await collectStream(provider.createMessage('sys', [], [{ name: 'browser_fill_ref', description: 'd', inputSchema: { type: 'object' } }], fastProfile));
    const calls = chunks.filter(c => c.type === 'tool_call').map(c => c.toolCall);
    expect(calls).toEqual([
      { id: 'call_1', name: 'browser_fill_ref', arguments: '{"ref": 3, "text": "x"}' },
      { id: 'call_2', name: 'browser_click_ref', arguments: '{"ref": 9}' },
    ]);
    expect(chunks.filter(c => c.type === 'text').map(c => c.text).join('')).toBe('Compilo.');
    expect(capturedRequestBody.tool_choice).toBe('auto');
  });

  it('separates parallel calls from gateways that omit the delta index', async () => {
    mockStreamChunks = [
      { choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'browser_fill_ref', arguments: '{"ref":3,' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '"text":"x"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 'b', function: { name: 'browser_click_ref', arguments: '{"ref":5}' } }] } }] },
    ];
    const provider = new OpenAICompatibleProvider(baseOptions);
    const chunks = await collectStream(provider.createMessage('sys', [], [{ name: 't', description: 'd' }], fastProfile));
    expect(chunks.filter(c => c.type === 'tool_call').map(c => c.toolCall)).toEqual([
      { id: 'a', name: 'browser_fill_ref', arguments: '{"ref":3,"text":"x"}' },
      { id: 'b', name: 'browser_click_ref', arguments: '{"ref":5}' },
    ]);
  });

  it('passes tool_calls, tool results and image parts through to the API', async () => {
    mockStreamChunks = [];
    const provider = new OpenAICompatibleProvider(baseOptions);
    await drainStream(provider.createMessage('sys', [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser_observe', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'browser_observe', content: 'obs' },
      { role: 'user', content: [{ type: 'text', text: 'state' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } }] },
    ], [], fastProfile));
    const msgs = capturedRequestBody.messages;
    expect(msgs[2].tool_calls[0].id).toBe('c1');
    expect(msgs[3]).toEqual({ role: 'tool', content: 'obs', tool_call_id: 'c1', name: 'browser_observe' });
    expect(msgs[4].content[1].image_url.url).toBe('data:image/jpeg;base64,AAA');
  });

  it('reports API failures as an error chunk (never as a fake final answer)', async () => {
    mockCreateError = Object.assign(new Error('upstream exploded'), { status: 502 });
    const provider = new OpenAICompatibleProvider(baseOptions);
    const chunks = await collectStream(provider.createMessage('sys', [], [], fastProfile));
    expect(chunks.filter(c => c.type === 'text')).toHaveLength(0);
    expect(chunks[0]).toMatchObject({ type: 'error', error: { status: 502, toolsUnsupported: false } });
    expect(chunks[0].error.message).toContain('upstream exploded');
  });

  it('flags endpoints that reject native tools', async () => {
    mockCreateError = Object.assign(new Error('"auto" tool choice requires --enable-auto-tool-choice'), { status: 400 });
    const provider = new OpenAICompatibleProvider(baseOptions);
    const chunks = await collectStream(provider.createMessage('sys', [], [{ name: 't', description: 'd' }], fastProfile));
    expect(chunks[0].error.toolsUnsupported).toBe(true);
    expect(isToolsUnsupportedError({ status: 400, message: 'tools are not supported by this model' })).toBe(true);
    expect(isToolsUnsupportedError({ status: 400, message: 'invalid temperature' })).toBe(false);
  });

  it('declares vision support from the profile', () => {
    const provider = new OpenAICompatibleProvider({ ...baseOptions, profiles: [{ ...fastProfile, supportsImages: true }], defaultProfileId: 'fast' });
    expect(provider.getModel().info.supportsImages).toBe(true);
  });

  it('recovers several XML calls from the reasoning channel (approval tag optional)', async () => {
    mockStreamChunks = [
      { choices: [{ delta: { reasoning_content: 'ok <tool>a</tool><input>1</input>\n<tool>b</tool><input>2</input>' } }] },
    ];
    const provider = new OpenAICompatibleProvider(baseOptions);
    const chunks = await collectStream(provider.createMessage('sys', [], [], fastProfile));
    expect(chunks.filter(c => c.type === 'text').map(c => c.text).join('')).toBe('<tool>a</tool><input>1</input>\n<tool>b</tool><input>2</input>');
  });
});
