import { OpenAICompatibleProvider } from '../models/providers/openai-compatible';
import { AgentFunction, FunctionMapping, ModelProfile, migrateProfile } from '../models/providers/types';
import { apiBaseCandidates, parseModelsResponse, DiscoveredModel } from '../models/providers/urlUtils';

export interface ProviderConfig {
  provider: 'openai-compatible';
  apiKey: string;
  apiModelId?: string;
  baseUrl?: string;
  openaiCompatibleModels?: Array<{ id: string; name: string; isReasoningModel?: boolean }>;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
  /** The candidate Base URL that actually worked (may differ from the input). */
  resolvedBaseUrl?: string;
}

export interface FetchModelsResult {
  ok: boolean;
  error?: string;
  models?: DiscoveredModel[];
  /** The candidate Base URL that served /models (may differ from the input). */
  resolvedBaseUrl?: string;
}

export class ConfigManager {
  private static instance: ConfigManager;

  private constructor() {}

  static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  async getProviderConfig(): Promise<ProviderConfig> {
    const result = await chrome.storage.sync.get({
      openaiCompatibleApiKey: '',
      openaiCompatibleModelId: '',
      openaiCompatibleBaseUrl: '',
      openaiCompatibleModels: [],
    });

    return {
      provider: 'openai-compatible',
      apiKey: result.openaiCompatibleApiKey,
      apiModelId: result.openaiCompatibleModelId,
      baseUrl: result.openaiCompatibleBaseUrl,
      openaiCompatibleModels: result.openaiCompatibleModels || [],
    };
  }

  async saveProviderConfig(config: Partial<ProviderConfig>): Promise<void> {
    await chrome.storage.sync.set(config);
  }

  async getConfiguredProviders(): Promise<string[]> {
    const result = await chrome.storage.sync.get({
      openaiCompatibleApiKey: '',
      openaiCompatibleBaseUrl: '',
    });

    if (result.openaiCompatibleApiKey || result.openaiCompatibleBaseUrl) {
      return ['openai-compatible'];
    }
    return [];
  }

  async getModelsForProvider(provider: string): Promise<{ id: string; name: string }[]> {
    if (provider !== 'openai-compatible') return [];
    const result = await chrome.storage.sync.get({ openaiCompatibleModels: [] });
    return OpenAICompatibleProvider.getAvailableModels({
      openaiCompatibleModels: result.openaiCompatibleModels || [],
    } as any);
  }

  async updateProviderAndModel(_provider: string, modelId: string): Promise<void> {
    await chrome.storage.sync.set({
      openaiCompatibleModelId: modelId,
    });
  }

  // ── Model Profiles ────────────────────────────────────────────────────────

  async getProfiles(): Promise<ModelProfile[]> {
    const result = await chrome.storage.sync.get({ modelProfiles: [] });
    // Auto-migrate legacy thinking flags to the standard reasoningEffort field
    return (result.modelProfiles || []).map(migrateProfile);
  }

  async saveProfiles(profiles: ModelProfile[]): Promise<void> {
    await chrome.storage.sync.set({ modelProfiles: profiles });
  }

  async getDefaultProfileId(): Promise<string> {
    const result = await chrome.storage.sync.get({ defaultProfileId: '' });
    return result.defaultProfileId || '';
  }

  async setDefaultProfileId(id: string): Promise<void> {
    await chrome.storage.sync.set({ defaultProfileId: id });
  }

  async getActiveProfile(): Promise<ModelProfile | null> {
    const [profiles, defaultId] = await Promise.all([
      this.getProfiles(),
      this.getDefaultProfileId(),
    ]);
    if (!profiles.length) return null;
    return profiles.find(p => p.id === defaultId) ?? profiles[0];
  }

  // ── Function → Profile Routing ───────────────────────────────────────────

  async getFunctionMappings(): Promise<FunctionMapping[]> {
    const result = await chrome.storage.sync.get({ functionMappings: [] });
    return result.functionMappings || [];
  }

  async setFunctionMapping(fn: AgentFunction, profileId: string): Promise<void> {
    const mappings = await this.getFunctionMappings();
    const idx = mappings.findIndex(m => m.function === fn);
    if (idx >= 0) {
      mappings[idx] = { function: fn, profileId };
    } else {
      mappings.push({ function: fn, profileId });
    }
    await chrome.storage.sync.set({ functionMappings: mappings });
  }

  async resolveProfileForFunction(fn: AgentFunction): Promise<ModelProfile | null> {
    const [mappings, profiles] = await Promise.all([
      this.getFunctionMappings(),
      this.getProfiles(),
    ]);
    const mapping = mappings.find(m => m.function === fn);
    if (mapping) {
      const profile = profiles.find(p => p.id === mapping.profileId);
      if (profile) return profile;
    }
    // Fallback: active (default) profile
    return this.getActiveProfile();
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  async getMemoryEnabled(): Promise<boolean> {
    const result = await chrome.storage.sync.get({ memoryEnabled: true });
    return result.memoryEnabled !== false;
  }

  async setMemoryEnabled(enabled: boolean): Promise<void> {
    await chrome.storage.sync.set({ memoryEnabled: enabled });
  }

  // ── Custom System Prompt ─────────────────────────────────────────────────

  async getCustomSystemPrompt(): Promise<string> {
    const result = await chrome.storage.local.get({ customSystemPrompt: '' });
    return result.customSystemPrompt || '';
  }

  async setCustomSystemPrompt(prompt: string): Promise<void> {
    await chrome.storage.local.set({ customSystemPrompt: prompt });
  }

  // ── Tool Timeouts ─────────────────────────────────────────────────────────

  async getToolTimeoutMs(): Promise<number> {
    const result = await chrome.storage.sync.get({ toolTimeoutMs: 600_000 });
    return result.toolTimeoutMs || 600_000;
  }

  async getNavigationTimeoutMs(): Promise<number> {
    const result = await chrome.storage.sync.get({ navigationTimeoutMs: 600_000 });
    return result.navigationTimeoutMs || 600_000;
  }

  // ── Max Steps ─────────────────────────────────────────────────────────────

  async getMaxSteps(): Promise<number> {
    const result = await chrome.storage.sync.get({ maxSteps: 200 });
    const n = Number(result.maxSteps);
    return Number.isFinite(n) && n > 0 ? n : 200;
  }

  async setMaxSteps(steps: number): Promise<void> {
    const n = Number(steps);
    await chrome.storage.sync.set({ maxSteps: Number.isFinite(n) && n > 0 ? n : 200 });
  }

  // ── Planning ──────────────────────────────────────────────────────────────

  async getPlanningEnabled(): Promise<boolean> {
    const result = await chrome.storage.sync.get({ planningEnabled: true });
    return result.planningEnabled !== false;
  }

  async setPlanningEnabled(enabled: boolean): Promise<void> {
    await chrome.storage.sync.set({ planningEnabled: enabled === true });
  }

  // ── Debug Mode ────────────────────────────────────────────────────────────
  // Device-local (not synced): total visibility into agent behavior, including
  // raw LLM responses, for troubleshooting.

  async getDebugMode(): Promise<boolean> {
    const result = await chrome.storage.local.get({ debugMode: false });
    return result.debugMode === true;
  }

  async setDebugMode(enabled: boolean): Promise<void> {
    await chrome.storage.local.set({ debugMode: enabled === true });
  }

  // ── Test Connection ───────────────────────────────────────────────────────

  async testConnection(
    baseUrl: string,
    apiKey: string,
    modelId: string
  ): Promise<TestConnectionResult> {
    const candidates = apiBaseCandidates(baseUrl);
    let lastError = 'Unknown error';

    for (const base of candidates) {
      const url = `${base}/chat/completions`;
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false,
          }),
        });

        if (response.ok) return { ok: true, resolvedBaseUrl: base };

        if (response.status === 404) {
          // Route not here — try the next candidate (e.g. add /v1)
          lastError = `Endpoint not found: ${url}`;
          continue;
        }

        if (response.status >= 500) {
          const text = await response.text().catch(() => '');
          return { ok: false, error: `Server error ${response.status}: ${text.slice(0, 200)}`, resolvedBaseUrl: base };
        }

        // Other 4xx (401, 403, 422, …) mean the route exists; the issue is auth,
        // model name, or request params — connection itself is fine.
        return { ok: true, resolvedBaseUrl: base };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      ok: false,
      error: `${lastError}. Tried: ${candidates.join(', ')}. Check the Base URL (root or /v1) and that the server is reachable.`,
    };
  }

  /**
   * Discover available models via GET /models, probing Base URL candidates so
   * the user can paste the endpoint with or without /v1.
   */
  async fetchModels(baseUrl: string, apiKey: string): Promise<FetchModelsResult> {
    const candidates = apiBaseCandidates(baseUrl);
    let lastError = 'Unknown error';

    for (const base of candidates) {
      const url = `${base}/models`;
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : undefined,
        });

        if (response.status === 404) {
          lastError = `Not found: ${url}`;
          continue;
        }
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          lastError = `HTTP ${response.status}: ${text.slice(0, 150)}`;
          continue;
        }

        const body = await response.json().catch(() => null);
        const models = parseModelsResponse(body);
        if (models.length === 0) {
          lastError = `No models returned by ${url}`;
          continue;
        }
        return { ok: true, models, resolvedBaseUrl: base };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return { ok: false, error: `${lastError}. Tried: ${candidates.join(', ')}.` };
  }
}
