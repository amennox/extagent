export interface ModelInfo {
  name: string;
  inputPrice: number;
  outputPrice: number;
  maxTokens?: number;
  contextWindow?: number;
  supportsImages?: boolean;
  supportsPromptCache?: boolean;
  cacheWritesPrice?: number;
  cacheReadsPrice?: number;
  isReasoningModel?: boolean;
  thinkingConfig?: {
    maxBudget?: number;
    outputPrice?: number;
  };
}

export type AgentFunction =
  | 'default'       // fallback per tutto ciò che non ha mapping esplicito
  | 'automation'    // task di automazione browser (input libero nel side panel)
  | 'skill'         // esecuzione di una skill salvata
  | 'recording'     // registrazione sequenza azioni (record & play)
  | 'smartPaste'    // Smart Paste — veloce, no thinking
  | 'smartExtract'  // Smart Extract — estrazione strutturata
  | 'observation';  // osservazione/analisi pagina senza azione

export interface FunctionMapping {
  function: AgentFunction;
  profileId: string;
}

/** OpenAI-standard reasoning effort levels. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ModelProfile {
  id: string;
  name: string;
  modelId: string;
  /** OpenAI-standard reasoning effort. Undefined = reasoning off. */
  reasoningEffort?: ReasoningEffort;
  /**
   * JSON string merged into the request body at call time. Escape hatch for
   * endpoints that need non-standard params (e.g. vLLM
   * `{"chat_template_kwargs": {"enable_thinking": false}}` for Qwen3).
   */
  extraBody?: string;
  /**
   * Use native OpenAI function calling (default: true when undefined). Set
   * to false for endpoints/models without tool support: the agent then falls
   * back to the XML text protocol described in the system prompt. The agent
   * also falls back automatically when the endpoint rejects `tools`.
   */
  nativeToolCalling?: boolean;
  /**
   * The model accepts images (vision). When true, observations include an
   * annotated screenshot (Set-of-Marks) sent as an image_url content part.
   */
  supportsImages?: boolean;
  contextWindowSize?: number;
  temperature?: number;
  maxTokens?: number;
  /** @deprecated Legacy Qwen/DashScope-style flag, auto-migrated to reasoningEffort. */
  enableThinking?: boolean;
  /** @deprecated Legacy, no longer sent. */
  thinkingBudget?: number;
}

/** Migrate legacy thinking flags to the standard reasoningEffort field. */
export function migrateProfile(p: ModelProfile): ModelProfile {
  if (p.reasoningEffort === undefined && p.enableThinking) {
    return { ...p, reasoningEffort: 'medium' };
  }
  return p;
}

export interface ProviderOptions {
  apiKey: string;
  baseUrl?: string;
  profiles?: ModelProfile[];
  defaultProfileId?: string;
  functionMappings?: FunctionMapping[];
  dangerouslyAllowBrowser?: boolean;
  // Legacy fields — used when profiles is empty
  apiModelId?: string;
  openaiCompatibleModels?: Array<{ id: string; name: string; isReasoningModel?: boolean }>;
  thinkingBudgetTokens?: number;
}

export interface StreamToolCall {
  id: string;
  name: string;
  /** Raw JSON arguments string as returned by the model */
  arguments: string;
}

export interface StreamError {
  status?: number | string;
  message: string;
  /** The endpoint rejected native tool calling (fallback to XML protocol) */
  toolsUnsupported?: boolean;
  /** The request exceeded the model context window */
  contextOverflow?: boolean;
}

/** OpenAI chat content part (text or image). */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

/** OpenAI-shaped chat message used across the agent. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

export interface StreamChunk {
  type: "text" | "reasoning" | "usage" | "tool_call" | "error";
  text?: string;
  toolCall?: StreamToolCall;
  error?: StreamError;
  reasoning?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

export type ApiStream = AsyncGenerator<StreamChunk, void, unknown>;

export interface LLMProvider {
  /**
   * @param requestOverrides Extra params merged into the request body for this
   * single call (e.g. `{ response_format: { type: "json_object" } }`).
   */
  createMessage(systemPrompt: string, messages: any[], tools?: any[], profile?: ModelProfile, requestOverrides?: Record<string, unknown>): ApiStream;
  getModel(): { id: string; info: ModelInfo };
  getDefaultProfile(): ModelProfile | null;
}
