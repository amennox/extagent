import { ConfigManager } from "../background/configManager";
import { getLang, t } from "../i18n";
import { LLMProvider, ModelProfile, StreamChunk } from "../models/providers/types";
import { TokenTrackingService } from "../tracking/tokenTrackingService";
import { ErrorHandler } from "./ErrorHandler";
import { MemoryManager } from "./MemoryManager";
import { PromptManager } from "./PromptManager";
import { TokenManager, DEFAULT_CONTEXT_WINDOW, observationCharBudget } from "./TokenManager";
import { setMaxReturnChars } from "./tools/utils";
import { ToolManager } from "./ToolManager";
import { requestApproval } from "./approvalManager";

const NAVIGATION_TOOLS = new Set([
  'browser_navigate',
  'browser_wait_for_navigation',
  'browser_navigate_back',
  'browser_navigate_forward',
]);

// Constants
export const DEFAULT_MAX_STEPS = 200;   // prevent infinite loops (configurable via setMaxSteps)

export type TaskOutcome = 'success' | 'failure' | 'cancelled' | 'maxSteps';

export interface RunStats {
  outcome: TaskOutcome;
  toolCalls: number;
  toolErrors: number;
  steps: number;
}

/**
 * Callback interface for execution
 */
export interface ExecutionCallbacks {
  onLlmChunk?: (s: string) => void;
  onLlmOutput: (s: string) => void;
  onToolOutput: (s: string) => void;
  onComplete: () => void;
  onError?: (error: any) => void;
  onToolStart?: (toolName: string, toolInput: string) => void;
  onToolEnd?: (result: string) => void;
  onSegmentComplete?: (segment: string) => void;
  onFallbackStarted?: () => void;
  /** Debug-mode only: total-visibility trace (raw LLM response, request, tool result). */
  onDebug?: (label: string, detail: string) => void;
}

/**
 * Adapter for handling callbacks in both streaming and non-streaming modes
 */
class CallbackAdapter {
  private originalCallbacks: ExecutionCallbacks;
  private isStreaming: boolean;
  private buffer: string = '';

  constructor(callbacks: ExecutionCallbacks, isStreaming: boolean) {
    this.originalCallbacks = callbacks;
    this.isStreaming = isStreaming;
  }

  get adaptedCallbacks(): ExecutionCallbacks {
    return {
      onLlmChunk: this.handleLlmChunk.bind(this),
      onLlmOutput: this.originalCallbacks.onLlmOutput,
      onToolOutput: this.originalCallbacks.onToolOutput,
      onComplete: this.handleComplete.bind(this),
      onError: this.originalCallbacks.onError,
      onToolStart: this.originalCallbacks.onToolStart,
      onToolEnd: this.originalCallbacks.onToolEnd,
      onSegmentComplete: this.originalCallbacks.onSegmentComplete,
      onFallbackStarted: this.originalCallbacks.onFallbackStarted,
      onDebug: this.originalCallbacks.onDebug
    };
  }

  private handleLlmChunk(chunk: string): void {
    if (this.isStreaming && this.originalCallbacks.onLlmChunk) {
      // Pass through in streaming mode
      this.originalCallbacks.onLlmChunk(chunk);
    } else {
      // Buffer in non-streaming mode
      this.buffer += chunk;
    }
  }

  private handleComplete(): void {
    // In non-streaming mode, emit the full buffer at completion
    if (!this.isStreaming && this.buffer.length > 0) {
      this.originalCallbacks.onLlmOutput(this.buffer);
      this.buffer = '';
    }

    this.originalCallbacks.onComplete();
  }
}

/**
 * ExecutionEngine handles streaming execution logic, non-streaming execution logic,
 * and fallback mechanisms.
 */
export class ExecutionEngine {
  private llmProvider: LLMProvider;
  private toolManager: ToolManager;
  private promptManager: PromptManager;
  private memoryManager: MemoryManager;
  private errorHandler: ErrorHandler;
  private configManager: ConfigManager | null;
  private activeProfile: ModelProfile | null = null;
  private tokenManager: TokenManager = new TokenManager();
  private cachedSystemPrompt: string | null = null;
  private maxSteps = DEFAULT_MAX_STEPS;
  private minMsBetweenCalls = 500;
  private stepRetryDelayMs = 3000;
  private lastLlmCallTime = 0;
  private debugMode = false;
  private lastRunStats: RunStats = { outcome: 'success', toolCalls: 0, toolErrors: 0, steps: 0 };

  constructor(
    llmProvider: LLMProvider,
    toolManager: ToolManager,
    promptManager: PromptManager,
    memoryManager: MemoryManager,
    errorHandler: ErrorHandler,
    configManager?: ConfigManager
  ) {
    this.llmProvider = llmProvider;
    this.toolManager = toolManager;
    this.promptManager = promptManager;
    this.memoryManager = memoryManager;
    this.errorHandler = errorHandler;
    this.configManager = configManager ?? null;
  }

  private async runWithTimeout(toolName: string, fn: () => Promise<string>): Promise<string> {
    const isNav = NAVIGATION_TOOLS.has(toolName);
    let ms: number;
    if (this.configManager) {
      ms = isNav
        ? await this.configManager.getNavigationTimeoutMs()
        : await this.configManager.getToolTimeoutMs();
    } else {
      ms = 600_000;
    }
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${toolName}" timed out after ${ms}ms`)), ms)
      ),
    ]);
  }

  setActiveProfile(profile: ModelProfile | null): void {
    this.activeProfile = profile;
    // Propagate the profile's context window to history trimming and to the
    // observation char limit, so both scale with the configured window
    // (default 256k) instead of hardcoded values.
    const contextWindow = profile?.contextWindowSize
      ?? this.llmProvider.getModel?.()?.info?.contextWindow
      ?? DEFAULT_CONTEXT_WINDOW;
    this.tokenManager = new TokenManager(contextWindow);
    setMaxReturnChars(observationCharBudget(contextWindow));
    // Profile change may alter language/config-sensitive prompt parts
    this.cachedSystemPrompt = null;
  }

  setMaxSteps(n: number): void { this.maxSteps = n; }
  getMaxSteps(): number { return this.maxSteps; }
  setMinMsBetweenCalls(ms: number): void { this.minMsBetweenCalls = ms; }
  setStepRetryDelayMs(ms: number): void { this.stepRetryDelayMs = ms; }
  setDebugMode(enabled: boolean): void { this.debugMode = enabled; }
  getLastRunStats(): RunStats { return { ...this.lastRunStats }; }

  /** Invalidate the per-task cached system prompt (e.g. page context changed). */
  invalidateSystemPromptCache(): void {
    this.cachedSystemPrompt = null;
  }

  private async getCachedSystemPrompt(): Promise<string> {
    if (this.cachedSystemPrompt === null) {
      this.cachedSystemPrompt = await this.promptManager.getSystemPrompt();
    }
    return this.cachedSystemPrompt;
  }

  /**
   * Safety-net summarizer: when trimHistory drops middle turns, condense them
   * with one non-streaming LLM call and keep the summary in history instead of
   * losing the information silently. Failures degrade gracefully (no summary).
   */
  private async summarizeRemovedHistory(summaryPrompt: string): Promise<string | null> {
    try {
      const stream = this.llmProvider.createMessage(
        "You are a summarizer. Condense the following conversation turns into a factual summary (max 500 tokens). Keep tool names, selectors, extracted values and page URLs. No preamble.",
        [{ role: "user", content: summaryPrompt }],
        undefined,
        this.activeProfile ?? undefined
      );
      let summary = "";
      for await (const chunk of stream) {
        if (chunk.type === "text" && chunk.text) summary += chunk.text;
      }
      summary = summary.trim();
      return summary.length > 0 ? summary : null;
    } catch (err) {
      console.warn("History summarizer failed, continuing without summary:", err);
      return null;
    }
  }

  /**
   * Main execution method with fallback support
   */
  async executePromptWithFallback(
    prompt: string,
    callbacks: ExecutionCallbacks,
    initialMessages: any[] = []
  ): Promise<void> {
    const streamingSupported = await this.errorHandler.isStreamingSupported();
    const isStreaming = streamingSupported && callbacks.onLlmChunk !== undefined;

    // Rebuild the system prompt at task start (page context / profile may have
    // changed since the previous task); it is then cached for the whole task.
    this.invalidateSystemPromptCache();

    try {
      // Use the execution method with appropriate streaming mode
      await this.executePrompt(prompt, callbacks, initialMessages, isStreaming);
    } catch (error) {
      console.warn("Execution failed, attempting fallback:", error);

      // Notify about fallback before switching modes
      if (callbacks.onFallbackStarted) {
        callbacks.onFallbackStarted();
      }

      // Check if this is a retryable error (rate limit or overloaded)
      if (this.errorHandler.isRetryableError(error)) {
        console.log("Retryable error detected in fallback handler:", error);
        // Ensure the error callback is called even during fallback
        if (callbacks.onError) {
          callbacks.onError(error);
        }
      }

      // Continue with fallback using non-streaming mode
      await this.executePrompt(prompt, callbacks, initialMessages, false);
    }
  }

  /**
   * Helper function to decode escaped HTML entities in a string
   * @param text The text to decode
   * @returns The decoded text
   */
  private decodeHtmlEntities(text: string): string {
    // Replace Unicode escape sequences with actual characters
    return text
      .replace(/\\u003c/g, '<')
      .replace(/\\u003e/g, '>')
      .replace(/\u003c/g, '<')
      .replace(/\u003e/g, '>');
  }

  private normalizeToolCallTags(text: string): string {
    // Defensive fix for models that close <tool> with the wrong tag
    return text
      .replace(/<tool>([^<]+)<\/input>/gi, '<tool>$1</tool>')
      .replace(/<tool>([^<]+)<\/requires_approval>/gi, '<tool>$1</tool>');
  }

  /**
   * Initialize message history with the prompt
   */
  private initializeMessages(prompt: string, initialMessages: any[]): any[] {
    // Use initial messages if provided, otherwise start with just the prompt
    const messages: any[] = initialMessages.length > 0
      ? [...initialMessages]
      : [{ role: "user", content: prompt }];

    // If we have initial messages and the last one isn't the current prompt,
    // add the current prompt
    if (initialMessages.length > 0 &&
        (messages[messages.length - 1].role !== "user" ||
         messages[messages.length - 1].content !== prompt)) {
      messages.push({ role: "user", content: prompt });
    }

    return messages;
  }

  /**
   * Track token usage from stream chunks
   */
  private trackTokenUsage(
    chunk: StreamChunk,
    inputTokens: number,
    outputTokens: number,
    tokenTracker: TokenTrackingService
  ): { updatedInputTokens: number, updatedOutputTokens: number } {
    let updatedInputTokens = inputTokens;
    let updatedOutputTokens = outputTokens;

    // Debug log to help diagnose token tracking issues
    console.debug(`Token update: input=${chunk.inputTokens || 0}, output=${chunk.outputTokens || 0}, cacheWrite=${chunk.cacheWriteTokens || 0}, cacheRead=${chunk.cacheReadTokens || 0}`);

    // Handle input tokens (only from message_start)
    if (chunk.inputTokens) {
      updatedInputTokens = chunk.inputTokens;
      // Track input tokens with cache tokens if available
      tokenTracker.trackInputTokens(
        updatedInputTokens,
        {
          write: chunk.cacheWriteTokens,
          read: chunk.cacheReadTokens
        }
      );
    }

    // Always track output tokens (from both message_start and message_delta)
    if (chunk.outputTokens) {
      const newOutputTokens = chunk.outputTokens;

      // Only track the delta (new tokens)
      if (newOutputTokens > updatedOutputTokens) {
        const delta = newOutputTokens - updatedOutputTokens;
        tokenTracker.trackOutputTokens(delta);
        updatedOutputTokens = newOutputTokens;
      }
    }

    return { updatedInputTokens, updatedOutputTokens };
  }

  /**
   * Process the LLM stream and handle streaming chunks
   */
  private async processLlmStream(
    messages: any[],
    adaptedCallbacks: ExecutionCallbacks,
    systemPrompt?: string
  ): Promise<{ accumulatedText: string, toolCallDetected: boolean }> {
    let accumulatedText = "";
    let streamBuffer = "";
    let toolCallDetected = false;

    // Rate limiting: ensure minimum time between LLM calls
    const now = Date.now();
    const elapsed = now - this.lastLlmCallTime;
    if (this.lastLlmCallTime > 0 && elapsed < this.minMsBetweenCalls) {
      await new Promise(r => setTimeout(r, this.minMsBetweenCalls - elapsed));
    }
    this.lastLlmCallTime = Date.now();

    // Tool schemas: the canonical protocol is the XML format in the system
    // prompt. Native function calling is sent ONLY when the profile opts in —
    // sending both makes models mix the formats (malformed tool calls) and
    // duplicates all schemas in the server-side prompt.
    const tools = this.activeProfile?.nativeToolCalling
      ? this.toolManager.getTools()
      : [];

    // Build the system prompt once per task and reuse it on every step: a
    // byte-identical prefix lets OpenAI-compatible servers (e.g. vLLM with
    // prefix caching) reuse the prefill across steps.
    const effectiveSystemPrompt = systemPrompt ?? await this.getCachedSystemPrompt();

    // Debug: outgoing request summary
    if (this.debugMode && adaptedCallbacks.onDebug) {
      const approxInput = Math.ceil(
        (effectiveSystemPrompt.length + messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0)) / 4
      );
      adaptedCallbacks.onDebug('→ LLM request', [
        `model: ${this.activeProfile?.modelId ?? '(default)'}`,
        `reasoning_effort: ${this.activeProfile?.reasoningEffort ?? 'off'}`,
        `messages: ${messages.length} · system prompt: ${effectiveSystemPrompt.length} chars`,
        `approx input: ~${approxInput} tokens · tools: ${tools.length}`,
      ].join('\n'));
    }

    const stream = this.llmProvider.createMessage(
      effectiveSystemPrompt,
      messages,
      tools,
      this.activeProfile ?? undefined
    );

    // Track token usage
    let inputTokens = 0;
    let outputTokens = 0;
    let accumulatedReasoning = "";
    const tokenTracker = TokenTrackingService.getInstance();

    for await (const chunk of stream) {
      if (this.errorHandler.isExecutionCancelled()) break;

      // Track token usage
      if (chunk.type === 'usage') {
        const result = this.trackTokenUsage(chunk, inputTokens, outputTokens, tokenTracker);
        inputTokens = result.updatedInputTokens;
        outputTokens = result.updatedOutputTokens;
      }

      // Capture reasoning (thinking) for debug visibility
      if (chunk.type === 'reasoning' && chunk.reasoning) {
        accumulatedReasoning += chunk.reasoning;
      }

      // Handle text chunks
      if (chunk.type === 'text' && chunk.text) {
        const textChunk = chunk.text;
        accumulatedText += textChunk;
        streamBuffer += textChunk;

        // Only look for complete tool calls with all three required tags
        const completeToolCallRegex = /(```(?:xml|bash)\s*)?<tool>(.*?)<\/tool>\s*<input>([\s\S]*?)<\/input>\s*<requires_approval>(.*?)<\/requires_approval>(\s*```)?/;

        // Try to match the complete tool call pattern
        const completeToolCallMatch = streamBuffer.match(completeToolCallRegex);

        // Only process complete tool calls with all three required tags
        if (completeToolCallMatch && !toolCallDetected) {
          toolCallDetected = true;
          console.log("Complete tool call detected:", completeToolCallMatch);

          // Extract the tool call with requires_approval value
          const [fullMatch, codeBlockStart, toolName, toolInput, requiresApprovalRaw] = completeToolCallMatch;

          // Find the start of the tool call
          const matchIndex = codeBlockStart
            ? (streamBuffer.indexOf("```xml") !== -1
               ? streamBuffer.indexOf("```xml")
               : streamBuffer.indexOf("```bash"))
            : streamBuffer.indexOf("<tool>");

          // Get text before the tool call
          const textBeforeToolCall = streamBuffer.substring(0, matchIndex);

          // Finalize the current segment
          if (textBeforeToolCall.trim() && adaptedCallbacks.onSegmentComplete) {
            adaptedCallbacks.onSegmentComplete(textBeforeToolCall);
          }

          // Signal that a tool call is starting
          if (adaptedCallbacks.onToolStart) {
            adaptedCallbacks.onToolStart(toolName.trim(), toolInput.trim());
          }

          // Clear the buffer
          streamBuffer = "";

          // Don't send any more chunks until tool execution is complete
          break;
        }

        // If no tool call detected yet, continue sending chunks
        if (!toolCallDetected && adaptedCallbacks.onLlmChunk) {
          adaptedCallbacks.onLlmChunk(textChunk);
        }
      }
    }

    // After streaming completes, process the full response
    console.log("Streaming completed. Accumulated text length:", accumulatedText.length);

    // Decode any escaped HTML entities in the accumulated text
    accumulatedText = this.decodeHtmlEntities(accumulatedText);
    accumulatedText = this.normalizeToolCallTags(accumulatedText);
    console.log("Decoded HTML entities in accumulated text");

    // Debug: raw LLM response (reasoning + visible answer), untouched
    if (this.debugMode && adaptedCallbacks.onDebug) {
      const parts: string[] = [];
      if (accumulatedReasoning.trim()) {
        parts.push(`[reasoning / <think>]\n${accumulatedReasoning.trim()}`);
      }
      parts.push(`[response]\n${accumulatedText || '(empty)'}`);
      parts.push(`[tokens] in=${inputTokens} out=${outputTokens}`);
      adaptedCallbacks.onDebug('← LLM raw response', parts.join('\n\n'));
    }

    adaptedCallbacks.onLlmOutput(accumulatedText);

    return { accumulatedText, toolCallDetected };
  }

  /**
   * Execute prompt with support for both streaming and non-streaming modes
   */
  async executePrompt(
    prompt: string,
    callbacks: ExecutionCallbacks,
    initialMessages: any[] = [],
    isStreaming: boolean
  ): Promise<void> {
    // Create adapter to handle streaming vs non-streaming
    const adapter = new CallbackAdapter(callbacks, isStreaming);
    const adaptedCallbacks = adapter.adaptedCallbacks;

    // Reset cancel flag at the start of execution
    this.errorHandler.resetCancel();
    this.lastRunStats = { outcome: 'success', toolCalls: 0, toolErrors: 0, steps: 0 };
    try {
      // Initialize messages with the prompt
      let messages = this.initializeMessages(prompt, initialMessages);

      // One system prompt per task: stable prefix across steps (prefix caching)
      const taskSystemPrompt = await this.getCachedSystemPrompt();

      let done = false;
      let step = 0;
      let consecutiveEmptyResponses = 0;
      const MAX_EMPTY_RESPONSES = 2;

      while (!done && step++ < this.maxSteps && !this.errorHandler.isExecutionCancelled()) {
        try {
          // Check for cancellation before each major step
          if (this.errorHandler.isExecutionCancelled()) break;

          // ── 1. Call LLM with streaming ───────────────────────────────────────
          // Retry up to 2 times on the same step before propagating the error
          const MAX_STEP_RETRIES = 2;
          let llmResult: Awaited<ReturnType<typeof this.processLlmStream>> | null = null;
          for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
            try {
              llmResult = await this.processLlmStream(messages, adaptedCallbacks, taskSystemPrompt);
              break;
            } catch (stepErr: any) {
              if (attempt < MAX_STEP_RETRIES && !this.errorHandler.isExecutionCancelled()) {
                const wait = this.stepRetryDelayMs * (attempt + 1);
                const lang = await getLang().catch(() => 'it' as const);
                adaptedCallbacks.onToolOutput(
                  t('agent.stepRetry', lang, { step: String(step), attempt: String(attempt + 1), max: String(MAX_STEP_RETRIES) })
                );
                await new Promise(r => setTimeout(r, wait));
              } else {
                throw stepErr;
              }
            }
          }
          const { accumulatedText } = llmResult!;

          // Check for cancellation after LLM response
          if (this.errorHandler.isExecutionCancelled()) break;

          // ── Empty response is NOT task completion ────────────────────────────
          // Reasoning models sometimes burn the whole output in the thinking
          // channel (or a channel we don't map) and return no visible text.
          // Treating that as "done" silently aborts the task mid-flight.
          if (!accumulatedText.trim()) {
            consecutiveEmptyResponses++;
            if (consecutiveEmptyResponses <= MAX_EMPTY_RESPONSES) {
              messages.push({
                role: "user",
                content: `Your previous response was empty (no visible text reached the client — likely everything went into the reasoning channel). The task is NOT finished. Continue from where you left off and reply ONLY with the required format:

<tool>tool_name</tool>
<input>arguments</input>
<requires_approval>true or false</requires_approval>

If the task is truly complete, reply with a short final summary in plain text instead.`,
              });
              continue;
            }
            // Persistent empty responses → fail explicitly, never fake success
            this.lastRunStats.outcome = 'failure';
            adaptedCallbacks.onLlmOutput(
              `Errore: il modello ha restituito ${MAX_EMPTY_RESPONSES + 1} risposte vuote consecutive (output finito nel canale di reasoning?). Task interrotto.`
            );
            done = true;
            break;
          }
          consecutiveEmptyResponses = 0;

          // Check for incomplete or malformed tool calls
          // This regex looks for tool calls that have <tool> and <input> but are missing <requires_approval>
          const incompleteApprovalRegex = /<tool>(.*?)<\/tool>\s*<input>([\s\S]*?)<\/input>(?!\s*<requires_approval>)/;
          const incompleteApprovalMatch = accumulatedText.match(incompleteApprovalRegex);

          // Check for interrupted tool calls (has input tag but interrupted during requires_approval)
          const interruptedToolRegex = /<tool>(.*?)<\/tool>\s*<input>([\s\S]*?)<\/input>\s*<requires(_approval)?$/;
          const interruptedToolMatch = accumulatedText.match(interruptedToolRegex);

          // Handle incomplete tool calls with missing requires_approval tag
          if (incompleteApprovalMatch && !accumulatedText.includes("<requires_approval>")) {
            const toolName = incompleteApprovalMatch[1].trim();
            const toolInput = incompleteApprovalMatch[2].trim();

            console.log("Detected incomplete tool call missing requires_approval tag:", incompleteApprovalMatch[0]);

            // Add a message to prompt the LLM to use the complete format
            messages.push(
              { role: "assistant", content: accumulatedText },
              {
                role: "user",
                content: `Error: Incomplete tool call format. You provided <tool>${toolName}</tool> and <input>${toolInput}</input> but no <requires_approval> tag. Please use the complete format with all three required tags:

<tool>tool_name</tool>
<input>arguments here</input>
<requires_approval>true or false</requires_approval>

The <requires_approval> tag is mandatory. Set it to "true" for purchases, data deletion, messages visible to others, sensitive-data forms, or any risky action. If unsure, set it to "true".`
              }
            );
            continue; // Continue to the next iteration
          }
          // Handle interrupted tool calls
          else if (interruptedToolMatch &&
              !interruptedToolMatch[0].includes("</requires_approval>") &&
              (interruptedToolMatch[0].endsWith("<requires") ||
               interruptedToolMatch[0].endsWith("<requires_approval"))) {

            const toolName = interruptedToolMatch[1].trim();
            const toolInput = interruptedToolMatch[2].trim();

            console.log("Detected interrupted tool call with partial requires_approval tag:", interruptedToolMatch[0]);

            // Instead of assuming approval, ask the LLM to complete the tool call properly
            messages.push(
              { role: "assistant", content: accumulatedText },
              {
                role: "user",
                content: `Error: Your tool call was interrupted. Please provide the complete tool call with all three required tags:

<tool>${toolName}</tool>
<input>${toolInput}</input>
<requires_approval>true or false</requires_approval>

The <requires_approval> tag is mandatory. Set it to "true" for purchases, data deletion, messages visible to others, sensitive-data forms, or any risky action. If unsure, set it to "true".`
              }
            );
            continue; // Continue to the next iteration
          }

          // ── 2. Parse for tool invocation ─────────────────────────────────────
          // Only look for complete tool calls with all three required tags
          const toolMatch = accumulatedText.match(
            /<tool>(.*?)<\/tool>\s*<input>([\s\S]*?)<\/input>\s*<requires_approval>(.*?)<\/requires_approval>/
          );

          // Check for various types of incomplete tool calls
          // 1. Tool tag without input tag
          const missingInputMatch = accumulatedText.match(/<tool>(.*?)<\/tool>(?!\s*<input>)/);
          // 2. Tool and input tags without requires_approval tag
          const missingApprovalMatch = accumulatedText.match(/<tool>(.*?)<\/tool>\s*<input>([\s\S]*?)<\/input>(?!\s*<requires_approval>)/);

          if (missingInputMatch !== null && toolMatch === null) {
            // Handle tool call missing input tag
            const toolName = missingInputMatch[1].trim();
            adaptedCallbacks.onToolOutput(`⚠️ Incomplete tool call detected: ${toolName} (missing input and requires_approval tags)`);

            // Add a message to prompt the LLM to complete the tool call with all required tags
            messages.push(
              { role: "assistant", content: accumulatedText },
              {
                role: "user",
                content: `Error: Incomplete tool call. You provided <tool>${toolName}</tool> but are missing the <input> and <requires_approval> tags. Please provide the complete tool call with all three required tags:

<tool>${toolName}</tool>
<input>arguments here</input>
<requires_approval>true or false</requires_approval>

The <requires_approval> tag is mandatory. Set it to "true" for purchases, data deletion, messages visible to others, sensitive-data forms, or any risky action. If unsure, set it to "true".`
              }
            );
            continue; // Continue to the next iteration
          } else if (missingApprovalMatch !== null && toolMatch === null) {
            // Handle tool call missing requires_approval tag
            const toolName = missingApprovalMatch[1].trim();
            const toolInput = missingApprovalMatch[2].trim();
            adaptedCallbacks.onToolOutput(`⚠️ Incomplete tool call detected: ${toolName} (missing requires_approval tag)`);

            // Add a message to prompt the LLM to complete the tool call with all required tags
            messages.push(
              { role: "assistant", content: accumulatedText },
              {
                role: "user",
                content: `Error: Incomplete tool call. You provided <tool>${toolName}</tool> and <input>${toolInput}</input> but are missing the <requires_approval> tag. Please provide the complete tool call with all three required tags:

<tool>${toolName}</tool>
<input>${toolInput}</input>
<requires_approval>true or false</requires_approval>

The <requires_approval> tag is mandatory. Set it to "true" for purchases, data deletion, messages visible to others, sensitive-data forms, or any risky action. If unsure, set it to "true".`
              }
            );
            continue; // Continue to the next iteration
          }

          if (!toolMatch) {
            // no tool tag ⇒ task complete
            done = true;
            break;
          }

          // Extract tool information from the complete tool call
          let toolName, toolInput, llmRequiresApproval;

          if (toolMatch) {
            const [, toolNameRaw, toolInputRaw, requiresApprovalRaw] = toolMatch;
            toolName = toolNameRaw.trim();
            toolInput = toolInputRaw.trim();
            llmRequiresApproval = requiresApprovalRaw.trim().toLowerCase() === 'true';
          } else {
            // No valid tool call found, task is complete
            done = true;
            break;
          }
          const tool = this.toolManager.findTool(toolName);

          // Check if the LLM has marked this as requiring approval
          const requiresApproval = llmRequiresApproval;
          const reason = llmRequiresApproval ? "The AI assistant has determined this action requires your approval." : "";

          if (!tool) {
            messages.push(
              { role: "assistant", content: accumulatedText },
              {
                role: "user",
                content: `Error: tool "${toolName}" not found. Available: ${this.toolManager.getTools()
                  .map((t) => t.name)
                  .join(", ")}`,
              }
            );
            continue;
          }

          // Check for cancellation before tool execution
          if (this.errorHandler.isExecutionCancelled()) break;

          // ── 3. Execute tool ──────────────────────────────────────────────────
          adaptedCallbacks.onToolOutput(`🕹️ tool: ${toolName} | args: ${toolInput}`);

          let result: string;

          if (requiresApproval) {
            // Notify the user that approval is required
            adaptedCallbacks.onToolOutput(`⚠️ This action requires approval: ${reason}`);

            // Get the current tab ID from chrome.tabs API
            const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            const tabId = tabs[0]?.id || 0;

            try {
              // Request approval from the user
              const approved = await requestApproval(tabId, toolName, toolInput, reason);

              if (approved) {
                // User approved, execute the tool
                adaptedCallbacks.onToolOutput(`✅ Action approved by user. Executing...`);

                // Create a context object to pass to the tool
                const context = {
                  requiresApproval: true,
                  approvalReason: reason
                };

                // Execute the tool with the context
                result = await this.runWithTimeout(toolName, () => tool.func(toolInput, context));
              } else {
                // User rejected, skip execution
                result = "Action cancelled by user.";
                adaptedCallbacks.onToolOutput(`❌ Action rejected by user.`);
              }
            } catch (approvalError) {
              console.error(`Error in approval process:`, approvalError);
              result = "Error in approval process. Action cancelled.";
              adaptedCallbacks.onToolOutput(`❌ Error in approval process: ${approvalError}`);
            }
          } else {
            // No approval required, execute the tool normally
            result = await this.runWithTimeout(toolName, () => tool.func(toolInput));
          }

          // Outcome stats
          this.lastRunStats.toolCalls++;
          if (typeof result === 'string' && /^Error\b|^❌/.test(result.trim())) {
            this.lastRunStats.toolErrors++;
          }

          // Signal that tool execution is complete
          if (adaptedCallbacks.onToolEnd) {
            adaptedCallbacks.onToolEnd(result);
          }

          // Debug: full (untruncated) tool result
          if (this.debugMode && adaptedCallbacks.onDebug) {
            adaptedCallbacks.onDebug(`⚙ tool result · ${toolName}`, result);
          }

          // Check for cancellation after tool execution
          if (this.errorHandler.isExecutionCancelled()) break;

          // ── 4. Record turn & prune history ───────────────────────────────────
          messages.push(
            { role: "assistant", content: accumulatedText }
          );

          // Add the tool result to the message history
          try {
            // Try to parse the result as JSON to handle special formats
            const parsedResult = JSON.parse(result);

            // Handle screenshot references
            if (parsedResult.type === "screenshotRef" && parsedResult.id) {
              // Create a message for the LLM with the screenshot reference
              // The actual screenshot display is handled by agentController.ts
              messages.push({
                role: "user",
                content: `Tool result: Screenshot captured (${parsedResult.id}). ${parsedResult.note || ''} Based on this image, please answer the user's original question: "${prompt}". Don't just describe the image - focus on answering the specific question or completing the task the user asked for.`
              });
            } else {
              // For other JSON results, stringify them nicely
              messages.push({
                role: "user",
                content: `Tool result: ${JSON.stringify(parsedResult, null, 2)}`
              });
            }
          } catch (error) {
            // If not valid JSON, add as plain text
            messages.push({ role: "user", content: `Tool result: ${result}` });
          }

          // Trim against the active profile's context window; if turns were
          // dropped, condense them into a summary instead of losing them.
          const { trimmed, removedSummaryPrompt } = this.tokenManager.trim(messages);
          if (removedSummaryPrompt && trimmed.length < messages.length) {
            const summary = await this.summarizeRemovedHistory(removedSummaryPrompt);
            if (summary) {
              // Insert right after the first (original task) message
              trimmed.splice(1, 0, {
                role: "user",
                content: `[Summary of earlier turns removed from history]\n${summary}`,
              });
            }
          }
          messages = trimmed;
        } catch (error) {
          // If an error occurs during execution, check if it was due to cancellation
          if (this.errorHandler.isExecutionCancelled()) break;
          throw error; // Re-throw if it wasn't a cancellation
        }
      }

      this.lastRunStats.steps = step;
      if (this.errorHandler.isExecutionCancelled()) {
        this.lastRunStats.outcome = 'cancelled';
        const lang = await getLang().catch(() => 'it' as const);
        adaptedCallbacks.onLlmOutput(`\n\n${t('agent.cancelledByUser', lang)}`);
      } else if (step >= this.maxSteps) {
        this.lastRunStats.outcome = 'maxSteps';
        const lang = await getLang().catch(() => 'it' as const);
        adaptedCallbacks.onLlmOutput(t('error.maxStepsReached', lang));
      } else if (this.lastRunStats.outcome !== 'failure') {
        // Completed normally; a high tool-error rate still marks it a failure.
        // (An explicit failure set inside the loop — e.g. persistent empty
        // responses — is preserved.)
        const { toolCalls, toolErrors } = this.lastRunStats;
        this.lastRunStats.outcome = toolCalls > 0 && toolErrors / toolCalls > 0.5 ? 'failure' : 'success';
      }
      adaptedCallbacks.onComplete();
    } catch (err: any) {
      // Check if this is a retryable error (rate limit or overloaded)
      if (this.errorHandler.isRetryableError(err)) {
        console.log("Retryable error detected:", err);
        // For retryable errors, notify but don't complete processing
        // This allows the fallback mechanism to retry while maintaining UI state
        if (adaptedCallbacks.onError) {
          adaptedCallbacks.onError(err);
        } else {
          adaptedCallbacks.onLlmOutput(this.errorHandler.formatErrorMessage(err));
        }

        // Notify about fallback before re-throwing
        if (adaptedCallbacks.onFallbackStarted) {
          adaptedCallbacks.onFallbackStarted();
        }

        // Get retry attempt from error if available, or default to 0
        const retryAttempt = (err as any).retryAttempt || 0;

        // Maximum number of retry attempts
        const MAX_RETRY_ATTEMPTS = 5;

        if (retryAttempt < MAX_RETRY_ATTEMPTS && !isStreaming) {
          // Only retry in non-streaming mode
          // Calculate backoff time using the ErrorHandler
          const backoffTime = this.errorHandler.calculateBackoffTime(err, retryAttempt);

          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, backoffTime));

          // Notify that we're retrying
          const errorType = this.errorHandler.isOverloadedError(err) ? 'server overload' : 'rate limit';
          adaptedCallbacks.onToolOutput(`Retrying after ${errorType} error (attempt ${retryAttempt + 1} of ${MAX_RETRY_ATTEMPTS})...`);

          // Increment retry attempt for the next try
          (err as any).retryAttempt = retryAttempt + 1;

          // Recursive retry with the same parameters
          return this.executePrompt(prompt, callbacks, initialMessages, isStreaming);
        } else if (retryAttempt >= MAX_RETRY_ATTEMPTS) {
          // We've exceeded the maximum number of retry attempts
          adaptedCallbacks.onLlmOutput(
            `Maximum retry attempts (${MAX_RETRY_ATTEMPTS}) exceeded. Please try again later.`
          );
          adaptedCallbacks.onComplete();
        } else {
          // In streaming mode, re-throw to trigger fallback
          throw err;
        }
      } else {
        // For other errors, show error message
        this.lastRunStats.outcome = 'failure';
        adaptedCallbacks.onLlmOutput(
          `Fatal error: ${err instanceof Error ? err.message : String(err)}`
        );

        // In streaming mode, re-throw to trigger fallback WITHOUT completing
        if (isStreaming) {
          throw err;
        } else {
          // Only complete processing if we're not going to fallback
          adaptedCallbacks.onComplete();
        }
      }
    }
  }
}
