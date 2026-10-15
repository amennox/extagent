import {
  normalizeApiBase,
  apiBaseCandidates,
  contextWindowFromModel,
  parseModelsResponse,
} from '../../../../src/models/providers/urlUtils';

describe('normalizeApiBase', () => {
  it('aggiunge /v1 se manca il path (origin-only)', () => {
    expect(normalizeApiBase('https://api-gb10.elettra.ai/')).toBe('https://api-gb10.elettra.ai/v1');
    expect(normalizeApiBase('https://api-gb10.elettra.ai')).toBe('https://api-gb10.elettra.ai/v1');
  });

  it('preserva un /v1 già presente', () => {
    expect(normalizeApiBase('https://api-gb10.elettra.ai/v1')).toBe('https://api-gb10.elettra.ai/v1');
    expect(normalizeApiBase('https://api-gb10.elettra.ai/v1/')).toBe('https://api-gb10.elettra.ai/v1');
  });

  it('rimuove un /chat/completions incollato per errore', () => {
    expect(normalizeApiBase('https://api-gb10.elettra.ai/v1/chat/completions')).toBe('https://api-gb10.elettra.ai/v1');
    expect(normalizeApiBase('https://host.tld/chat/completions')).toBe('https://host.tld/v1');
  });

  it('preserva path custom non-root', () => {
    expect(normalizeApiBase('https://host.tld/openai/v1')).toBe('https://host.tld/openai/v1');
  });

  it('gestisce stringa vuota', () => {
    expect(normalizeApiBase('')).toBe('');
    expect(normalizeApiBase('   ')).toBe('');
  });
});

describe('apiBaseCandidates', () => {
  it('prova sia il root sia /v1 quando manca la versione', () => {
    const c = apiBaseCandidates('https://api-gb10.elettra.ai');
    expect(c).toContain('https://api-gb10.elettra.ai/v1');
  });

  it('per un /v1 esplicito prova anche senza (setup rari)', () => {
    const c = apiBaseCandidates('https://host.tld/v1');
    expect(c[0]).toBe('https://host.tld/v1');
    expect(c).toContain('https://host.tld');
  });

  it('non produce duplicati', () => {
    const c = apiBaseCandidates('https://host.tld/v1');
    expect(new Set(c).size).toBe(c.length);
  });
});

describe('contextWindowFromModel', () => {
  it('legge max_model_len (vLLM)', () => {
    expect(contextWindowFromModel({ id: 'x', max_model_len: 262144 })).toBe(262144);
  });
  it('legge context_length', () => {
    expect(contextWindowFromModel({ id: 'x', context_length: 128000 })).toBe(128000);
  });
  it('legge meta.n_ctx_train (llama.cpp)', () => {
    expect(contextWindowFromModel({ id: 'x', meta: { n_ctx_train: 32768 } })).toBe(32768);
  });
  it('ritorna undefined se assente', () => {
    expect(contextWindowFromModel({ id: 'x' })).toBeUndefined();
  });
});

describe('parseModelsResponse', () => {
  it('estrae id e context window dal formato OpenAI /models', () => {
    const body = {
      object: 'list',
      data: [
        { id: 'qwen3-30b', object: 'model', max_model_len: 262144 },
        { id: 'qwen3-7b', object: 'model', context_length: 32768 },
        { id: 'no-ctx', object: 'model' },
      ],
    };
    const models = parseModelsResponse(body);
    expect(models).toHaveLength(3);
    expect(models[0]).toEqual({ id: 'qwen3-30b', contextWindow: 262144 });
    expect(models[2]).toEqual({ id: 'no-ctx', contextWindow: undefined });
  });

  it('accetta anche un array diretto', () => {
    const models = parseModelsResponse([{ id: 'a' }, { id: 'b' }]);
    expect(models.map(m => m.id)).toEqual(['a', 'b']);
  });

  it('scarta voci senza id', () => {
    const models = parseModelsResponse({ data: [{ id: '' }, { foo: 1 }, { id: 'ok' }] });
    expect(models.map(m => m.id)).toEqual(['ok']);
  });

  it('ritorna array vuoto per body non valido', () => {
    expect(parseModelsResponse(null)).toEqual([]);
    expect(parseModelsResponse({})).toEqual([]);
  });
});
