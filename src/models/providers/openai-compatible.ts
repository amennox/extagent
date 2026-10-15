import OpenAI from "openai";
import { LLMProvider, ModelInfo, ModelProfile, ProviderOptions, ApiStream, migrateProfile } from './types';
import { normalizeApiBase } from './urlUtils';

/**
 * Stateful stream filter that silently routes `<think>…</think>` blocks out of
 * the visible text. Needed for endpoints (e.g. Galene) that inline the
 * reasoning in the content instead of using the `reasoning_content` field.
 * Handles tags split across chunks (`<thi` + `nk>`) via a look-behind tail.
 */
export class ThinkTagFilter {
  private static readonly OPEN = '<think>';
  private static readonly CLOSE = '</think>';
  private inThink = false;
  private tail = '';

  /** Longest k < tag.length such that buf ends with the first k chars of tag. */
  private static partialSuffixLen(buf: string, tag: string): number {
    const max = Math.min(tag.length - 1, buf.length);
    for (let k = max; k > 0; k--) {
      if (buf.endsWith(tag.slice(0, k))) return k;
    }
    return 0;
  }

  push(chunk: string): { text: string; reasoning: string } {
    let buf = this.tail + chunk;
    this.tail = '';
    let text = '';
    let reasoning = '';
    while (buf.length > 0) {
      const tag = this.inThink ? ThinkTagFilter.CLOSE : ThinkTagFilter.OPEN;
      const idx = buf.indexOf(tag);
      if (idx >= 0) {
        if (this.inThink) reasoning += buf.slice(0, idx);
        else text += buf.slice(0, idx);
        buf = buf.slice(idx + tag.length);
        this.inThink = !this.inThink;
      } else {
        // Hold back a possible partial tag at the end of the buffer
        const keep = ThinkTagFilter.partialSuffixLen(buf, tag);
        const emit = buf.slice(0, buf.length - keep);
        if (this.inThink) reasoning += emit;
        else text += emit;
        this.tail = buf.slice(buf.length - keep);
        buf = '';
      }
    }
    return { text, reasoning };
  }

  /** End of stream: emit what is buffered (as reasoning if still inside a think block). */
  flush(): { text: string; reasoning: string } {
    const rest = this.tail;
    this.tail = '';
    if (this.inThink) {
      this.inThink = false;
      return { text: '', reasoning: rest };
    }
    return { text: rest, reasoning: '' };
  }
}

/** One-shot cleanup for non-streaming text (defensive strip). */
export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export function isContextOverflowError(error: unknown): boolean {
  const e = error as any;
  const msg = (e?.message ?? '').toLowerCase();
  const status = e?.status ?? e?.statusCode ?? 0;
  if (status === 413 || status === 422) return true;
  if (status === 500 && (
    msg.includes('context_length') || msg.includes('too many tokens') ||
    msg.includes('maximum context') || msg.includes('request too large') ||
    msg.includes('token limit')
  )) return true;
  return false;
}

export interface OpenAICompatibleModelInfo extends ModelInfo {
  isReasoning?: boolean;
}

export interface OpenAICompatibleProviderOptions extends ProviderOptions {
  openaiCompatibleModels?: Array<{ id: string; name: string; isReasoning?: boolean; }>;
}

export class OpenAICompatibleProvider implements LLMProvider {
  static getAvailableModels(options: OpenAICompatibleProviderOptions): { id: string; name: string }[] {
    return (options.openaiCompatibleModels || []).map(m => ({ id: m.id, name: m.name }));
  }

  private options: OpenAICompatibleProviderOptions;
  private client: OpenAI;

  constructor(options: ProviderOptions) {
    this.options = options as OpenAICompatibleProviderOptions;
    // Normalize the Base URL to the API root: strips a pasted /chat/completions
    // path and trailing slashes, and defaults origin-only URLs to /v1.
    const baseUrl = normalizeApiBase(this.options.baseUrl ?? '');
    this.options.baseUrl = baseUrl;
    this.client = new OpenAI({
      apiKey: this.options.apiKey,
      baseURL: baseUrl,
      dangerouslyAllowBrowser: true,
      timeout: 600_000, // 600s — needed for slow local LLMs
    });
  }

  getDefaultProfile(): ModelProfile | null {
    const profiles = this.options.profiles ?? [];
    if (!profiles.length) return null;
    return profiles.find(p => p.id === this.options.defaultProfileId) ?? profiles[0];
  }

  private mapTools(tools?: any[]): any[] {
    if (!tools?.length) return [];
    return tools.map(tool => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema ?? {
          type: "object",
          properties: {
            input: { type: "string", description: "The input to the tool" },
          },
          required: ["input"],
        },
      },
    }));
  }

  async *createMessage(
    systemPrompt: string,
    messages: any[],
    tools?: any[],
    profile?: ModelProfile,
    requestOverrides?: Record<string, unknown>
  ): ApiStream {
    const activeProfile = profile ?? this.getDefaultProfile();

    // Resolve model ID: profile → legacy apiModelId → fallback
    const modelId = activeProfile?.modelId ?? this.options.apiModelId ?? 'gpt-3.5-turbo';

    const filteredMessages = messages.filter(message =>
      !(message.role === "user" && typeof message.content === "string" && message.content.startsWith("[SYSTEM INSTRUCTION:"))
    );

    const openaiMessages = [
      { role: "system", content: systemPrompt },
      ...filteredMessages.map(msg => ({ role: msg.role, content: msg.content })),
    ];

    const effectiveProfile = activeProfile ? migrateProfile(activeProfile) : null;
    console.log("🔍 Using model:", modelId, "| reasoning_effort:", effectiveProfile?.reasoningEffort ?? 'off');

    console.log("🔍 LLM request URL:", this.options.baseUrl, "| model:", modelId);

    const reasoningOn = !!effectiveProfile?.reasoningEffort;
    const maxOut = effectiveProfile?.maxTokens ?? 8192;
    const profileTemp = effectiveProfile?.temperature;
    // Greedy decoding (temp 0) degrades Qwen3 in thinking mode (repetitions and
    // loops), so default to 0.6 when reasoning is on unless the profile sets a
    // positive temperature explicitly.
    const temperature = reasoningOn
      ? (profileTemp && profileTemp > 0 ? profileTemp : 0.6)
      : (profileTemp ?? 0);

    // We send BOTH max_completion_tokens (OpenAI standard) and max_tokens
    // (universally honored by local servers like llama.cpp / older vLLM) so the
    // output budget is always applied.
    const requestBody: any = {
      model: modelId,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: maxOut,
      max_tokens: maxOut,
      temperature,
    };

    // Reasoning control.
    // - `reasoning_effort` is the OpenAI standard (honored by compliant endpoints).
    // - `enable_thinking` (top-level) and `chat_template_kwargs.enable_thinking`
    //   are how local Qwen3 servers (vLLM / llama.cpp) toggle the <think> phase.
    //   These MUST be sent explicitly: Qwen3 thinks BY DEFAULT, so a "fast"
    //   profile that omits the flag would keep reasoning, burn the output budget
    //   on <think> and frequently truncate before emitting the tool call — which
    //   the agent loop then reads as "no tool call → task done" and stops early.
    if (reasoningOn) {
      requestBody.reasoning_effort = effectiveProfile!.reasoningEffort;
    }
    requestBody.enable_thinking = reasoningOn;
    requestBody.chat_template_kwargs = { enable_thinking: reasoningOn };
    // Per-call overrides (e.g. response_format for structured extraction)
    if (requestOverrides) {
      Object.assign(requestBody, requestOverrides);
    }
    // Escape hatch for non-standard endpoints (merged last, may override).
    if (effectiveProfile?.extraBody) {
      try {
        Object.assign(requestBody, JSON.parse(effectiveProfile.extraBody));
      } catch (e) {
        console.warn("Invalid extraBody JSON in profile, ignoring:", e);
      }
    }

    const mappedTools = this.mapTools(tools);
    if (mappedTools.length > 0) {
      requestBody.tools = mappedTools;
      requestBody.tool_choice = "auto";
    }

    try {
      const stream = await this.client.chat.completions.create(requestBody) as unknown as AsyncIterable<any>;
      const accumulatedToolCalls: any[] = [];
      // Dual-mode reasoning handling (silent): dedicated reasoning_content
      // field AND inline <think> tags in content are both filtered out of the
      // visible text and emitted as "reasoning" chunks.
      const thinkFilter = new ThinkTagFilter();
      let emittedText = false;
      let allReasoning = '';

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        // Reasoning channels: `reasoning_content` (DeepSeek/vLLM convention)
        // and `reasoning` (OpenRouter/other gateways). Handle both.
        const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoningDelta) {
          allReasoning += reasoningDelta;
          yield { type: "reasoning", reasoning: reasoningDelta };
        }
        if (delta?.content) {
          const filtered = thinkFilter.push(delta.content);
          if (filtered.reasoning) { allReasoning += filtered.reasoning; yield { type: "reasoning", reasoning: filtered.reasoning }; }
          if (filtered.text) { emittedText = true; yield { type: "text", text: filtered.text }; }
        }
        if (delta?.tool_calls) {
          console.log("🔍 LLM tool calls:", delta.tool_calls);
          for (const toolCall of delta.tool_calls) {
            const existingIndex = accumulatedToolCalls.findIndex(tc => tc.index === toolCall.index);
            if (existingIndex >= 0) {
              if (toolCall.function) {
                const existingFn = accumulatedToolCalls[existingIndex].function || {};
                accumulatedToolCalls[existingIndex].function = {
                  ...existingFn,
                  ...toolCall.function,
                  name: toolCall.function.name || existingFn.name || '',
                  arguments: (existingFn.arguments || '') + (toolCall.function.arguments || ''),
                };
              }
            } else {
              accumulatedToolCalls.push(toolCall);
            }
          }
        }
        if (chunk.usage) {
          console.log("🔍 LLM usage:", chunk.usage);
          yield {
            type: "usage",
            inputTokens: chunk.usage.prompt_tokens || 0,
            outputTokens: chunk.usage.completion_tokens || 0,
          };
        }
      }

      // Flush any residual buffered text from the think-tag filter
      const rest = thinkFilter.flush();
      if (rest.reasoning) { allReasoning += rest.reasoning; yield { type: "reasoning", reasoning: rest.reasoning }; }
      if (rest.text) { emittedText = true; yield { type: "text", text: rest.text }; }

      // Safety net: some models/endpoints emit the final answer (including the
      // XML tool call) inside the reasoning channel, or never close <think>.
      // If no visible text and no native tool call came through but the reasoning
      // contains a complete tool call, recover it — otherwise the agent loop
      // would read the empty answer as "no tool call → task done" and stop.
      if (!emittedText && accumulatedToolCalls.length === 0 && allReasoning) {
        const recovered = allReasoning.match(
          /<tool>[\s\S]*?<\/tool>\s*<input>[\s\S]*?<\/input>\s*<requires_approval>[\s\S]*?<\/requires_approval>/
        );
        if (recovered) yield { type: "text", text: recovered[0] };
      }

      // Convert accumulated OpenAI tool calls back to XML format expected by ExecutionEngine
      if (accumulatedToolCalls.length > 0) {
        console.log("🔍 Emitting accumulated tool calls:", JSON.stringify(accumulatedToolCalls));
        for (const toolCall of accumulatedToolCalls) {
          const fn = toolCall.function;
          const toolName = fn?.name;
          if (fn && toolName) {
            let inputStr = fn.arguments || '';
            try {
              const parsed = JSON.parse(inputStr);
              if (parsed !== null && typeof parsed === 'object' && typeof parsed.input === 'string') {
                inputStr = parsed.input;
              }
            } catch {
              // Not JSON — use raw arguments string as-is
            }
            const toolText = `<tool>${toolName}</tool><input>${inputStr}</input><requires_approval>false</requires_approval>`;
            console.log("🔍 Converted tool call:", toolText);
            yield { type: "text", text: toolText };
          } else {
            console.warn("🔍 Skipped tool call with missing name:", JSON.stringify(toolCall));
          }
        }
      }
    } catch (error) {
      const status = (error as any)?.status ?? (error as any)?.statusCode ?? 'unknown';
      console.error(
        "🔍 LLM API Error:",
        "status=", status,
        "url=", this.options.baseUrl + '/chat/completions',
        "model=", modelId,
        error
      );
      if (status === 404) {
        yield { type: "text", text: `Error: LLM endpoint returned 404. Check that Base URL is the API root (e.g. https://api-gb10.elettra.ai/v1), not the full /chat/completions path.` };
      } else {
        yield { type: "text", text: "Error: Failed to stream response from OpenAI-Compatible API. Please try again." };
      }
    }
  }

  getModel(): { id: string; info: OpenAICompatibleModelInfo } {
    const defaultProfile = this.getDefaultProfile();
    if (defaultProfile) {
      return {
        id: defaultProfile.modelId,
        info: {
          name: defaultProfile.name,
          inputPrice: 0,
          outputPrice: 0,
          maxTokens: defaultProfile.maxTokens ?? 4096,
          contextWindow: defaultProfile.contextWindowSize ?? 256000,
          isReasoning: !!migrateProfile(defaultProfile).reasoningEffort,
        },
      };
    }

    // Legacy fallback when no profiles configured
    const modelId = this.options.apiModelId;
    const models = this.options.openaiCompatibleModels || [];
    const model = models.find(m => m.id === modelId);

    if (model) {
      return {
        id: modelId!,
        info: {
          name: model.name,
          inputPrice: 0,
          outputPrice: 0,
          maxTokens: 4096,
          isReasoning: model.isReasoning,
        },
      };
    }

    if (models.length > 0) {
      const first = models[0];
      return {
        id: first.id,
        info: {
          name: first.name,
          inputPrice: 0,
          outputPrice: 0,
          maxTokens: 4096,
          isReasoning: first.isReasoning,
        },
      };
    }

    const fallbackId = modelId || 'gpt-3.5-turbo';
    return {
      id: fallbackId,
      info: {
        name: fallbackId,
        inputPrice: 0,
        outputPrice: 0,
        maxTokens: 4096,
        isReasoning: false,
      },
    };
  }
}
