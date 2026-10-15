import { ConfigManager, ProviderConfig } from '../../../src/background/configManager';
import { AgentFunction, FunctionMapping, ModelProfile } from '../../../src/models/providers/types';

jest.mock('../../../src/models/providers/openai-compatible', () => ({
  OpenAICompatibleProvider: {
    getAvailableModels: jest.fn().mockReturnValue([
      { id: 'qwen3-35b', name: 'Qwen3 35B' },
    ]),
  },
}));

const mockChromeStorage = {
  sync: {
    get: jest.fn(),
    set: jest.fn(),
  },
  local: {
    get: jest.fn(),
    set: jest.fn(),
  },
};

Object.defineProperty(global, 'chrome', {
  value: { storage: mockChromeStorage },
  writable: true,
});

const thinkingProfile: ModelProfile = {
  id: 'thinking',
  name: 'Qwen3 Thinking',
  modelId: 'qwen3-35b',
  enableThinking: true,
  thinkingBudget: 8192,
};

const fastProfile: ModelProfile = {
  id: 'fast',
  name: 'Qwen3 Fast',
  modelId: 'qwen3-35b',
  enableThinking: false,
};

describe('ConfigManager', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    (ConfigManager as any).instance = undefined;
    configManager = ConfigManager.getInstance();
    jest.clearAllMocks();
  });

  describe('getInstance', () => {
    it('restituisce una singleton instance', () => {
      const a = ConfigManager.getInstance();
      const b = ConfigManager.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('debug mode', () => {
    it('default false quando non configurato', async () => {
      mockChromeStorage.local.get.mockResolvedValue({ debugMode: false });
      expect(await configManager.getDebugMode()).toBe(false);
    });

    it('restituisce true quando abilitato', async () => {
      mockChromeStorage.local.get.mockResolvedValue({ debugMode: true });
      expect(await configManager.getDebugMode()).toBe(true);
    });

    it('setDebugMode persiste in chrome.storage.local', async () => {
      mockChromeStorage.local.set.mockResolvedValue(undefined);
      await configManager.setDebugMode(true);
      expect(mockChromeStorage.local.set).toHaveBeenCalledWith({ debugMode: true });
    });

    it('normalizza valori non booleani a false', async () => {
      mockChromeStorage.local.get.mockResolvedValue({ debugMode: 'yes' });
      expect(await configManager.getDebugMode()).toBe(false);
    });
  });

  describe('getProviderConfig', () => {
    it('restituisce sempre provider openai-compatible', async () => {
      mockChromeStorage.sync.get.mockResolvedValue({
        openaiCompatibleApiKey: 'test-key',
        openaiCompatibleModelId: 'qwen3-35b',
        openaiCompatibleBaseUrl: 'http://localhost:8000/v1',
        openaiCompatibleModels: [{ id: 'qwen3-35b', name: 'Qwen3 35B' }],
      });
      const config = await configManager.getProviderConfig();
      expect(config.provider).toBe('openai-compatible');
      expect(config.apiKey).toBe('test-key');
    });

    it('propaga errori di Chrome storage', async () => {
      mockChromeStorage.sync.get.mockRejectedValue(new Error('Storage error'));
      await expect(configManager.getProviderConfig()).rejects.toThrow('Storage error');
    });
  });

  describe('getModelsForProvider', () => {
    it('restituisce i modelli openai-compatible dallo storage', async () => {
      mockChromeStorage.sync.get.mockResolvedValue({
        openaiCompatibleModels: [{ id: 'qwen3-35b', name: 'Qwen3 35B' }],
      });
      const models = await configManager.getModelsForProvider('openai-compatible');
      expect(models).toEqual([{ id: 'qwen3-35b', name: 'Qwen3 35B' }]);
    });

    it('restituisce array vuoto per provider non supportato', async () => {
      mockChromeStorage.sync.get.mockResolvedValue({ openaiCompatibleModels: [] });
      const models = await configManager.getModelsForProvider('unsupported');
      expect(models).toEqual([]);
    });
  });

  describe('profili modello', () => {
    it('getProfiles restituisce array vuoto se nessun profilo salvato', async () => {
      mockChromeStorage.sync.get.mockResolvedValue({ modelProfiles: [] });
      const profiles = await configManager.getProfiles();
      expect(profiles).toEqual([]);
    });

    it('getProfiles restituisce i profili salvati', async () => {
      mockChromeStorage.sync.get.mockResolvedValue({ modelProfiles: [thinkingProfile, fastProfile] });
      const profiles = await configManager.getProfiles();
      expect(profiles).toHaveLength(2);
      expect(profiles[0].id).toBe('thinking');
    });

    it('saveProfiles persiste i profili in chrome.storage.sync', async () => {
      mockChromeStorage.sync.set.mockResolvedValue(undefined);
      await configManager.saveProfiles([thinkingProfile]);
      expect(mockChromeStorage.sync.set).toHaveBeenCalledWith({ modelProfiles: [thinkingProfile] });
    });

    it('getActiveProfile restituisce il profilo con defaultProfileId', async () => {
      mockChromeStorage.sync.get
        .mockResolvedValueOnce({ modelProfiles: [thinkingProfile, fastProfile] })
        .mockResolvedValueOnce({ defaultProfileId: 'fast' });
      const profile = await configManager.getActiveProfile();
      expect(profile?.id).toBe('fast');
    });

    it('getActiveProfile restituisce il primo profilo se defaultProfileId assente', async () => {
      mockChromeStorage.sync.get
        .mockResolvedValueOnce({ modelProfiles: [thinkingProfile, fastProfile] })
        .mockResolvedValueOnce({ defaultProfileId: '' });
      const profile = await configManager.getActiveProfile();
      expect(profile?.id).toBe('thinking');
    });

    it('getActiveProfile restituisce null se nessun profilo', async () => {
      mockChromeStorage.sync.get
        .mockResolvedValueOnce({ modelProfiles: [] })
        .mockResolvedValueOnce({ defaultProfileId: '' });
      const profile = await configManager.getActiveProfile();
      expect(profile).toBeNull();
    });

    it('setDefaultProfileId salva il defaultProfileId nello storage', async () => {
      mockChromeStorage.sync.set.mockResolvedValue(undefined);
      await configManager.setDefaultProfileId('fast');
      expect(mockChromeStorage.sync.set).toHaveBeenCalledWith({ defaultProfileId: 'fast' });
    });
  });

  describe('routing funzione→profilo', () => {
    it('getFunctionMappings restituisce array vuoto se nessun mapping salvato', async () => {
      mockChromeStorage.sync.get.mockResolvedValue({ functionMappings: [] });
      const mappings = await configManager.getFunctionMappings();
      expect(mappings).toEqual([]);
    });

    it('getFunctionMappings restituisce i mapping salvati', async () => {
      const saved: FunctionMapping[] = [{ function: 'smartPaste', profileId: 'fast' }];
      mockChromeStorage.sync.get.mockResolvedValue({ functionMappings: saved });
      const mappings = await configManager.getFunctionMappings();
      expect(mappings).toEqual(saved);
    });

    it('setFunctionMapping aggiunge un nuovo mapping', async () => {
      mockChromeStorage.sync.get.mockResolvedValue({ functionMappings: [] });
      mockChromeStorage.sync.set.mockResolvedValue(undefined);
      await configManager.setFunctionMapping('automation', 'thinking');
      expect(mockChromeStorage.sync.set).toHaveBeenCalledWith({
        functionMappings: [{ function: 'automation', profileId: 'thinking' }],
      });
    });

    it('setFunctionMapping aggiorna un mapping esistente', async () => {
      const existing: FunctionMapping[] = [{ function: 'smartPaste', profileId: 'fast' }];
      mockChromeStorage.sync.get.mockResolvedValue({ functionMappings: existing });
      mockChromeStorage.sync.set.mockResolvedValue(undefined);
      await configManager.setFunctionMapping('smartPaste', 'thinking');
      expect(mockChromeStorage.sync.set).toHaveBeenCalledWith({
        functionMappings: [{ function: 'smartPaste', profileId: 'thinking' }],
      });
    });

    it('resolveProfileForFunction restituisce il profilo mappato', async () => {
      mockChromeStorage.sync.get
        .mockResolvedValueOnce({ functionMappings: [{ function: 'smartPaste', profileId: 'fast' }] })
        .mockResolvedValueOnce({ modelProfiles: [thinkingProfile, fastProfile] });
      const profile = await configManager.resolveProfileForFunction('smartPaste');
      expect(profile?.id).toBe('fast');
    });

    it('resolveProfileForFunction cade sul profilo attivo se nessun mapping', async () => {
      mockChromeStorage.sync.get
        .mockResolvedValueOnce({ functionMappings: [] })           // getFunctionMappings
        .mockResolvedValueOnce({ modelProfiles: [thinkingProfile, fastProfile] }) // getProfiles in Promise.all
        .mockResolvedValueOnce({ modelProfiles: [thinkingProfile, fastProfile] }) // getProfiles inside getActiveProfile
        .mockResolvedValueOnce({ defaultProfileId: 'thinking' });  // getDefaultProfileId inside getActiveProfile
      const profile = await configManager.resolveProfileForFunction('automation');
      expect(profile?.id).toBe('thinking');
    });
  });

  describe('testConnection', () => {
    beforeEach(() => {
      global.fetch = jest.fn();
    });

    it('restituisce ok=true se il server risponde con status 200', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ status: 200, ok: true });
      const result = await configManager.testConnection('http://localhost:8000/v1', 'key', 'qwen3-35b');
      expect(result.ok).toBe(true);
    });

    it('restituisce ok=true anche per status 400 (server raggiungibile)', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ status: 400, ok: false });
      const result = await configManager.testConnection('http://localhost:8000/v1', 'key', 'model');
      expect(result.ok).toBe(true);
    });

    it('restituisce ok=false con error se status >= 500', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        status: 500,
        text: jest.fn().mockResolvedValue('Internal Server Error'),
      });
      const result = await configManager.testConnection('http://localhost:8000/v1', 'key', 'model');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('500');
    });

    it('restituisce ok=false con error se la chiamata fallisce (network error)', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('Network unreachable'));
      const result = await configManager.testConnection('http://localhost:8000/v1', 'key', 'model');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Network unreachable');
    });

    it('usa il baseUrl passato come parametro nella chiamata', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ status: 200 });
      await configManager.testConnection('http://my-server:9000/v1', 'key', 'model');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://my-server:9000/v1/chat/completions',
        expect.any(Object)
      );
    });

    it('rimuove trailing slash dal baseUrl prima di aggiungere il path', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ status: 200 });
      await configManager.testConnection('http://localhost:8000/v1/', 'key', 'model');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:8000/v1/chat/completions',
        expect.any(Object)
      );
    });

    it('risolve un URL origin-only su /v1 automaticamente', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ status: 200, ok: true });
      const result = await configManager.testConnection('https://api-gb10.elettra.ai', 'key', 'model');
      expect(result.ok).toBe(true);
      expect(result.resolvedBaseUrl).toBe('https://api-gb10.elettra.ai/v1');
      expect(global.fetch).toHaveBeenCalledWith('https://api-gb10.elettra.ai/v1/chat/completions', expect.any(Object));
    });

    it('fa fallback su un candidato alternativo se il primo dà 404', async () => {
      // input con /v1 esplicito: candidati = [.../v1, ... (root)]
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({ status: 404, ok: false }) // .../v1
        .mockResolvedValueOnce({ status: 200, ok: true });  // root
      const result = await configManager.testConnection('https://host.tld/v1', 'key', 'model');
      expect(result.ok).toBe(true);
      expect(result.resolvedBaseUrl).toBe('https://host.tld');
    });
  });

  describe('fetchModels', () => {
    beforeEach(() => {
      global.fetch = jest.fn();
    });

    it('restituisce i modelli con la context window dal formato OpenAI', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true, status: 200,
        json: jest.fn().mockResolvedValue({
          data: [{ id: 'qwen3-30b', max_model_len: 262144 }, { id: 'qwen3-7b', context_length: 32768 }],
        }),
      });
      const result = await configManager.fetchModels('https://api-gb10.elettra.ai/v1', 'key');
      expect(result.ok).toBe(true);
      expect(result.models).toEqual([
        { id: 'qwen3-30b', contextWindow: 262144 },
        { id: 'qwen3-7b', contextWindow: 32768 },
      ]);
    });

    it('risolve un URL origin-only su /v1 e chiama /v1/models', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true, status: 200, json: jest.fn().mockResolvedValue({ data: [{ id: 'm', max_model_len: 128000 }] }),
      });
      const result = await configManager.fetchModels('https://api-gb10.elettra.ai', 'key');
      expect(result.ok).toBe(true);
      expect(result.resolvedBaseUrl).toBe('https://api-gb10.elettra.ai/v1');
      expect(global.fetch).toHaveBeenCalledWith('https://api-gb10.elettra.ai/v1/models', expect.any(Object));
    });

    it('restituisce errore se nessun candidato serve /models', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ status: 404, ok: false });
      const result = await configManager.fetchModels('https://host.tld', 'key');
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
