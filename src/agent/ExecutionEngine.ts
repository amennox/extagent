import type { ConfigManager } from "../background/configManager";
import { DEFAULT_MAX_STEPS as CONFIG_DEFAULT_MAX_STEPS } from "../background/defaults";
import { getLang, Lang } from "../i18n";
import { ChatMessage, LLMProvider, ModelProfile, StreamChunk, StreamError, StreamToolCall } from "../models/providers/types";
import { TokenTrackingService } from "../tracking/tokenTrackingService";
import type { EncodedImage } from "../utils/image";
import {
  buildStateMessage, classifyResult, estimateTokens, hasMalformedXmlCall, isErrorResult,
  LoopDetector, parseXmlToolCalls, PlanStep, renderMessages, stripXmlCalls, ToolCallRecord, ToolResultRecord,
  Transcript, TurnRecord,
} from "./AgentState";
import { ErrorHandler } from "./ErrorHandler";
import { MemoryManager } from "./MemoryManager";
import { getCurrentPage } from "./PageContextManager";
import { PromptManager, Protocol } from "./PromptManager";
import { DEFAULT_CONTEXT_WINDOW, observationCharBudget, TokenManager } from "./TokenManager";
import { ToolManager } from "./ToolManager";
import { requestApproval } from "./approvalManager";
import { ApprovalMode, approvalReason } from "./approvalPolicy";
import { callSignature, exposedToolSpecs, getToolSpec, normalizeCall, ToolSpec, toolDescription } from "./toolCatalog";
import { getMapEntry, setVisionEnabled } from "./tools/pageMapTools";
import { toolResultImage, toolResultText } from "./tools/types";
import { lastDialog, MAX_RETURN_CHARS, setMaxReturnChars, truncate } from "./tools/utils";

export const DEFAULT_MAX_STEPS = CONFIG_DEFAULT_MAX_STEPS;

export type TaskOutcome = 'success' | 'failure' | 'cancelled' | 'maxSteps';

export interface RunStats {
  outcome: TaskOutcome;
  toolCalls: number;
  toolErrors: number;
  steps: number;
  /** Successful state-changing actions (clicks, fills, navigations…) */
  actions: number;
}

export interface RunResult {
  outcome: TaskOutcome;
  /** Final answer shown to the user (also the only thing kept in cross-task history) */
  finalText: string;
  stats: RunStats;
}

export interface ExecutionCallbacks {
  onLlmChunk?: (s: string) => void;
  /** Called ONCE with the final answer */
  onLlmOutput: (s: string) => void;
  onToolOutput: (s: string) => void;
  onComplete: () => void;
  onError?: (error: any) => void;
  onToolStart?: (toolName: string, toolInput: string) => void;
  onToolEnd?: (result: string) => void;
  /** A tool produced an image (screenshot): show it to the user */
  onToolImage?: (image: EncodedImage, note: string) => void;
  onSegmentComplete?: (segment: string) => void;
  onFallbackStarted?: () => void;
  /** Debug-mode only: total-visibility trace (raw LLM response, request, tool result). */
  onDebug?: (label: string, detail: string) => void;
}

export interface ExecuteOptions {
  /** Extra context for the first user message (memories, procedures, plan…) */
  taskHints?: string[];
  initialPlan?: PlanStep[];
  maxSteps?: number;
}

class LlmStreamError extends Error {
  constructor(public info: StreamError) {
    super(info.message);
  }
}

interface LlmTurn {
  text: string;
  reasoning: string;
  toolCalls: StreamToolCall[];
}

interface PendingCall {
  id: string;
  name: string;
  raw: string | Record<string, any>;
  modelFlag?: boolean;
}

const NAVIGATION_TOOLS = new Set(['browser_navigate', 'browser_navigate_back', 'browser_navigate_forward', 'browser_wait_for_navigation', 'browser_tab']);
const LONG_TOOLS = new Set(['extract_with_schema', 'paginate_and_collect', 'smart_extract_data', 'run_procedure', 'fill_form_from_data']);
const PAGE_CHANGE_RE = /Navigated (to|back|forward)|Switched to tab|Procedure .* (completed|stopped)/;
const SESSION_LOST_RE = /Target (page, context or browser )?(has been )?closed|detached|Session closed|No target with given id/i;

/**
 * ExecutionEngine runs the observe → act loop for one task.
 *
 * Differences from a plain chat loop (each fixes a cause of "the agent gets
 * lost after a few steps"):
 * - native function calling by default (several tool calls per turn), with an
 *   automatic fallback to the XML text protocol for endpoints without tools;
 * - the context is rebuilt every step from a turn-based transcript: stale
 *   observations are compacted, old turns are summarized under pressure;
 * - a [STATE] message every step (tab, plan, dialog, warnings, screenshot);
 * - loop detection (warn, then stop) and an approval policy owned by the
 *   extension, not by the model;
 * - screenshots are sent to vision models as real image parts.
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
  private maxSteps = DEFAULT_MAX_STEPS;
  private minMsBetweenCalls = 300;
  private stepRetryDelayMs = 3000;
  private lastLlmCallTime = 0;
  private debugMode = false;
  /** The endpoint rejected native tools during this session */
  private nativeUnsupported = false;
  private lastRunStats: RunStats = { outcome: 'success', toolCalls: 0, toolErrors: 0, steps: 0, actions: 0 };

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

  setActiveProfile(profile: ModelProfile | null): void {
    this.activeProfile = profile;
    const contextWindow = profile?.contextWindowSize
      ?? this.llmProvider.getModel?.()?.info?.contextWindow
      ?? DEFAULT_CONTEXT_WINDOW;
    this.tokenManager = new TokenManager(contextWindow);
    setMaxReturnChars(observationCharBudget(contextWindow));
  }

  setMaxSteps(n: number): void { this.maxSteps = n; }
  getMaxSteps(): number { return this.maxSteps; }
  setMinMsBetweenCalls(ms: number): void { this.minMsBetweenCalls = ms; }
  setStepRetryDelayMs(ms: number): void { this.stepRetryDelayMs = ms; }
  setDebugMode(enabled: boolean): void { this.debugMode = enabled; }
  getLastRunStats(): RunStats { return { ...this.lastRunStats }; }

  /** Kept for API compatibility: the prompt is rebuilt at every task start. */
  invalidateSystemPromptCache(): void { /* no-op */ }

  private protocol(): Protocol {
    if (this.nativeUnsupported) return 'xml';
    return this.activeProfile?.nativeToolCalling === false ? 'xml' : 'native';
  }

  private vision(): boolean {
    return !!(this.activeProfile?.supportsImages ?? this.llmProvider.getModel?.()?.info?.supportsImages);
  }

  /** Read a setting; missing/failed config falls back to the default. */
  private async setting<T>(read: (c: ConfigManager) => Promise<T>, fallback: T): Promise<T> {
    if (!this.configManager) return fallback;
    try {
      const v = await read(this.configManager);
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async exposedTools(vision: boolean): Promise<ToolSpec[]> {
    const advanced = await this.setting(c => c.getAdvancedToolsEnabled(), false);
    const registered = new Set(this.toolManager.getTools().map(t => t.name));
    return exposedToolSpecs(registered, { vision, advanced });
  }

  private async approvalMode(): Promise<ApprovalMode> {
    return this.setting<ApprovalMode>(c => c.getApprovalMode(), 'risky');
  }

  /** Backward-compatible entry point (there is no destructive re-run fallback anymore). */
  async executePromptWithFallback(
    prompt: string,
    callbacks: ExecutionCallbacks,
    initialMessages: any[] = [],
    options: ExecuteOptions = {}
  ): Promise<RunResult> {
    return this.executePrompt(prompt, callbacks, initialMessages, true, options);
  }

  async executePrompt(
    prompt: string,
    callbacks: ExecutionCallbacks,
    initialMessages: any[] = [],
    _isStreaming = true,
    options: ExecuteOptions = {}
  ): Promise<RunResult> {
    this.errorHandler.resetCancel();
    this.lastRunStats = { outcome: 'success', toolCalls: 0, toolErrors: 0, steps: 0, actions: 0 };
    const lang: Lang = await getLang().catch(() => 'it' as Lang);
    const S = RUN_STRINGS[lang];
    const transcript = new Transcript();
    if (options.initialPlan?.length) transcript.plan = options.initialPlan.map(p => ({ ...p }));
    const loop = new LoopDetector();
    const history = sanitizeHistory(initialMessages, prompt);
    const task = buildTaskMessage(prompt, options.taskHints, lang);
    const maxSteps = options.maxSteps ?? this.maxSteps;
    const vision = this.vision();
    setVisionEnabled(vision);

    let protocol = this.protocol();
    const tools = await this.exposedTools(vision);
    let systemPrompt = await this.promptManager.getSystemPrompt({ lang, protocol, vision, tools });
    const approvalMode = await this.approvalMode();

    let finalText = '';
    let warning: string | undefined;
    let emptyResponses = 0;
    let overflowRetried = false;
    let step = 0;

    try {
      while (step < maxSteps && !this.errorHandler.isExecutionCancelled()) {
        step++;
        await this.compactIfNeeded(transcript, history, task, systemPrompt, lang, false);

        const img = vision ? transcript.currentImage() : null;
        const state = buildStateMessage({
          step, maxSteps, plan: transcript.plan, warning, vision, lang,
          ...(await this.pageState()),
          image: img?.image ? 'attached' : img?.stale ? 'stale' : 'none',
        });
        const messages = renderMessages(transcript, { history, task, state, image: img?.image ?? null, lang });

        let llm: LlmTurn;
        try {
          llm = await this.callLlmWithRetries(systemPrompt, messages, protocol === 'native' ? tools : [], protocol, callbacks, step, lang);
        } catch (err) {
          if (err instanceof LlmStreamError && err.info.toolsUnsupported && protocol === 'native') {
            this.nativeUnsupported = true;
            protocol = 'xml';
            systemPrompt = await this.promptManager.getSystemPrompt({ lang, protocol, vision, tools });
            callbacks.onToolOutput(S.switchedToXml);
            step--;
            continue;
          }
          if (err instanceof LlmStreamError && err.info.contextOverflow && !overflowRetried) {
            overflowRetried = true;
            history.length = 0;
            await this.compactIfNeeded(transcript, history, task, systemPrompt, lang, true);
            step--;
            continue;
          }
          throw err;
        }
        if (this.errorHandler.isExecutionCancelled()) break;

        // ── Collect tool calls (native first, XML in text as fallback) ──────
        let turnProtocol: 'native' | 'xml' = protocol;
        let calls: PendingCall[] = llm.toolCalls.map(tc => ({ id: tc.id, name: tc.name, raw: parseArguments(tc.arguments) }));
        if (calls.length === 0) {
          const xml = parseXmlToolCalls(llm.text);
          if (xml.length) {
            turnProtocol = 'xml';
            calls = xml.map((c, i) => ({ id: `xml_${step}_${i}`, name: c.name, raw: c.input, modelFlag: c.requiresApproval }));
          }
        }

        if (calls.length === 0) {
          if (!llm.text.trim()) {
            emptyResponses++;
            if (emptyResponses <= 2) {
              transcript.addTurn({ text: '', calls: [], results: [], feedback: S.emptyResponse, protocol: turnProtocol });
              continue;
            }
            this.lastRunStats.outcome = 'failure';
            finalText = S.emptyFailure;
            break;
          }
          if (hasMalformedXmlCall(llm.text)) {
            transcript.addTurn({ text: llm.text, calls: [], results: [], feedback: S.malformedCall, protocol: 'xml' });
            continue;
          }
          finalText = llm.text.trim();
          break;
        }
        emptyResponses = 0;

        const visible = turnProtocol === 'xml' ? stripXmlCalls(llm.text) : llm.text.trim();
        if (visible && callbacks.onSegmentComplete) callbacks.onSegmentComplete(visible);

        // ── Execute calls sequentially ────────────────────────────────────
        const turn: TurnRecord = { text: llm.text, calls: [], results: [], protocol: turnProtocol };
        let skipReason: string | null = null;
        for (let i = 0; i < calls.length; i++) {
          const c = calls[i];
          const { args, input } = normalizeCall(c.name, c.raw);
          const record: ToolCallRecord = { id: c.id, name: c.name, args, input };
          turn.calls.push(record);
          if (skipReason || this.errorHandler.isExecutionCancelled()) {
            turn.results.push({ callId: c.id, name: c.name, text: skipReason ?? S.cancelled, kind: 'meta', mutating: false, isError: false, skipped: true });
            continue;
          }
          const result = await this.executeCall(record, c.modelFlag, callbacks, transcript, approvalMode, lang);
          turn.results.push(result);
          const spec = getToolSpec(c.name);
          loop.record({
            signature: callSignature(c.name, args),
            name: c.name,
            isError: result.isError,
            noChange: /no visible changes/.test(result.text),
            mutating: result.mutating,
            observation: spec?.kind === 'observation',
          });
          if (i < calls.length - 1) {
            if (result.isError) skipReason = S.skippedAfterError;
            else if (PAGE_CHANGE_RE.test(result.text)) skipReason = S.skippedAfterPageChange;
            else if (/rejected by the user/i.test(result.text)) skipReason = S.skippedAfterRejection;
          }
        }
        transcript.addTurn(turn);

        const status = loop.status(lang);
        if (status.stop) {
          this.lastRunStats.outcome = 'failure';
          finalText = status.stop;
          break;
        }
        warning = status.warning;
      }

      this.lastRunStats.steps = step;
      if (this.errorHandler.isExecutionCancelled()) {
        this.lastRunStats.outcome = 'cancelled';
        finalText = finalText || S.cancelledByUser;
      } else if (!finalText && step >= maxSteps) {
        this.lastRunStats.outcome = 'maxSteps';
        finalText = S.maxSteps(maxSteps, transcript.plan);
      } else if (this.lastRunStats.outcome !== 'failure') {
        const { toolCalls, toolErrors } = this.lastRunStats;
        this.lastRunStats.outcome = toolCalls > 0 && toolErrors / toolCalls > 0.5 ? 'failure' : 'success';
      }
    } catch (err) {
      this.lastRunStats.outcome = 'failure';
      this.lastRunStats.steps = step;
      const message = err instanceof Error ? err.message : String(err);
      finalText = S.fatal(message);
      callbacks.onError?.(err);
    }

    callbacks.onLlmOutput(finalText);
    callbacks.onComplete();
    return { outcome: this.lastRunStats.outcome, finalText, stats: { ...this.lastRunStats } };
  }

  // ── One tool call ────────────────────────────────────────────────────────

  private async executeCall(
    call: ToolCallRecord,
    modelFlag: boolean | undefined,
    callbacks: ExecutionCallbacks,
    transcript: Transcript,
    approvalMode: ApprovalMode,
    lang: Lang
  ): Promise<ToolResultRecord> {
    const S = RUN_STRINGS[lang];
    const { name, args, input } = call;
    callbacks.onToolStart?.(name, input);
    callbacks.onToolOutput(`🕹️ tool: ${name} | args: ${displayArgs(name, args, input)}`);

    const finish = (text: string, image?: EncodedImage): ToolResultRecord => {
      const isError = isErrorResult(text);
      const cls = classifyResult(name, text);
      this.lastRunStats.toolCalls++;
      if (isError) this.lastRunStats.toolErrors++;
      else if (cls.mutating) this.lastRunStats.actions++;
      if (image) callbacks.onToolImage?.(image, text.split('\n')[0]);
      callbacks.onToolEnd?.(text);
      if (this.debugMode) callbacks.onDebug?.(`⚙ tool result · ${name}`, text);
      return { callId: call.id, name, text, image, kind: cls.kind, family: cls.family, mutating: cls.mutating, isError };
    };

    // Engine-handled meta tool
    if (name === 'update_plan') {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      transcript.plan = steps
        .filter((s: any) => s && typeof s.title === 'string')
        .map((s: any) => ({ title: String(s.title).slice(0, 160), status: ['todo', 'doing', 'done'].includes(s.status) ? s.status : 'todo' }));
      return finish(`Plan updated (${transcript.plan.length} steps).`);
    }

    const tool = this.toolManager.findTool(name);
    if (!tool) {
      const available = (await this.exposedTools(this.vision())).map(t => t.name).join(', ');
      return finish(`Error: tool "${name}" does not exist. Available tools: ${available}`);
    }

    // Approval decided by the extension (the model's flag only adds caution)
    const refArg = args.ref ?? (name.endsWith('_ref') ? Number(String(args.input ?? input).split('|')[0]) : undefined);
    const entry = refArg !== undefined && !isNaN(Number(refArg)) ? getMapEntry(Number(refArg)) : undefined;
    const reason = approvalReason(name, args, { mode: approvalMode, entry, modelFlag });
    if (reason) {
      callbacks.onToolOutput(`⚠️ ${S.approvalNeeded}: ${reason}`);
      let approved = false;
      try {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        approved = await requestApproval(tabs[0]?.id ?? 0, name, displayArgs(name, args, input), reason);
      } catch (err) {
        console.error('Approval error:', err);
      }
      if (!approved) {
        callbacks.onToolOutput(`❌ ${S.rejected}`);
        return finish(S.rejectedForModel);
      }
      callbacks.onToolOutput(`✅ ${S.approved}`);
    }

    let raw;
    try {
      raw = await this.runWithTimeout(name, () => tool.func(input, reason ? { requiresApproval: true, approvalReason: reason } : undefined));
    } catch (err) {
      raw = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    let text = toolResultText(raw) ?? '';
    if (SESSION_LOST_RE.test(text)) text += `\n${S.sessionLost}`;
    if (text.length > MAX_RETURN_CHARS * 2) text = truncate(text, MAX_RETURN_CHARS * 2);
    return finish(text, toolResultImage(raw));
  }

  private async runWithTimeout<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
    let ms = NAVIGATION_TOOLS.has(toolName)
      ? await this.setting(c => c.getNavigationTimeoutMs(), 60_000)
      : await this.setting(c => c.getToolTimeoutMs(), 30_000);
    if (!Number.isFinite(ms) || ms <= 0) ms = 30_000;
    if (LONG_TOOLS.has(toolName)) ms = Math.max(ms, 600_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`tool "${toolName}" timed out after ${Math.round(ms / 1000)}s`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── Page state for the [STATE] message ───────────────────────────────────

  private async pageState(): Promise<{ url?: string; title?: string; tabs?: number; dialog?: { type: string; message: string } | null }> {
    try {
      const page = getCurrentPage(this.toolManager.getPage());
      const url = page.url();
      const title = await Promise.race([
        page.title(),
        new Promise<string>(resolve => setTimeout(() => resolve(''), 1500)),
      ]).catch(() => '');
      let tabs: number | undefined;
      try { tabs = page.context().pages().length; } catch { tabs = undefined; }
      const dialog = lastDialog ? { type: lastDialog.type(), message: lastDialog.message() } : null;
      return { url, title, tabs, dialog };
    } catch {
      return {};
    }
  }

  // ── Context compaction ───────────────────────────────────────────────────

  private async compactIfNeeded(
    transcript: Transcript,
    history: ChatMessage[],
    task: string,
    systemPrompt: string,
    lang: Lang,
    force: boolean
  ): Promise<void> {
    const threshold = this.tokenManager.summarizeThreshold;
    const estimate = () => estimateTokens(renderMessages(transcript, { history, task, state: '', lang }), systemPrompt);
    if (!force && estimate() <= threshold) return;

    // Cross-task history goes first
    while (history.length && (force || estimate() > threshold)) history.shift();
    if (!force && estimate() <= threshold) return;

    const keep = force ? 2 : 4;
    const n = transcript.turns.length - keep;
    if (n <= 0) return;
    const compact = transcript.renderTurnsCompact(0, n);
    const summary = await this.summarize(transcript.summary, compact, lang);
    transcript.summary = summary ?? `${transcript.summary ?? ''}\n${compact}`.slice(-6000);
    transcript.dropOldest(keep);
  }

  private async summarize(previous: string | null, turns: string, lang: Lang): Promise<string | null> {
    try {
      const instruction = lang === 'en'
        ? 'Condense these browser-agent steps into a factual progress summary (max 300 words): what was done, on which pages, values entered or extracted, what failed, what remains. Keep exact names, URLs and data. No preamble.'
        : 'Riassumi questi passi di un agente browser in un riepilogo fattuale dei progressi (max 300 parole): cosa è stato fatto, su quali pagine, valori inseriti o estratti, cosa è fallito, cosa resta da fare. Mantieni nomi, URL e dati esatti. Niente preamboli.';
      const content = `${previous ? `${lang === 'en' ? 'Previous summary' : 'Riepilogo precedente'}:\n${previous}\n\n` : ''}${turns}`;
      const stream = this.llmProvider.createMessage(instruction, [{ role: 'user', content: content.slice(0, 60_000) }], undefined, this.activeProfile ?? undefined);
      let text = '';
      for await (const chunk of stream) {
        if (chunk.type === 'text' && chunk.text) text += chunk.text;
        if (chunk.type === 'error') return null;
      }
      text = text.trim();
      return text || null;
    } catch {
      return null;
    }
  }

  // ── LLM call ─────────────────────────────────────────────────────────────

  private async callLlmWithRetries(
    systemPrompt: string,
    messages: ChatMessage[],
    tools: ToolSpec[],
    protocol: Protocol,
    callbacks: ExecutionCallbacks,
    step: number,
    lang: Lang
  ): Promise<LlmTurn> {
    const MAX_RETRIES = 2;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callLlm(systemPrompt, messages, tools, protocol, callbacks, lang);
      } catch (err) {
        const fatal = err instanceof LlmStreamError && (err.info.toolsUnsupported || err.info.contextOverflow);
        if (fatal || attempt >= MAX_RETRIES || this.errorHandler.isExecutionCancelled()) throw err;
        callbacks.onToolOutput(RUN_STRINGS[lang].stepRetry(step, attempt + 1, MAX_RETRIES));
        await new Promise(r => setTimeout(r, this.stepRetryDelayMs * (attempt + 1)));
      }
    }
  }

  private async callLlm(
    systemPrompt: string,
    messages: ChatMessage[],
    tools: ToolSpec[],
    protocol: Protocol,
    callbacks: ExecutionCallbacks,
    lang: Lang
  ): Promise<LlmTurn> {
    const elapsed = Date.now() - this.lastLlmCallTime;
    if (this.lastLlmCallTime > 0 && elapsed < this.minMsBetweenCalls) {
      await new Promise(r => setTimeout(r, this.minMsBetweenCalls - elapsed));
    }
    this.lastLlmCallTime = Date.now();

    const providerTools = tools.map(t => ({ name: t.name, description: toolDescription(t, lang), inputSchema: t.schema }));
    if (this.debugMode && callbacks.onDebug) {
      callbacks.onDebug('→ LLM request', [
        `model: ${this.activeProfile?.modelId ?? '(default)'} · protocol: ${protocol} · vision: ${this.vision()}`,
        `messages: ${messages.length} · system prompt: ${systemPrompt.length} chars · tools: ${providerTools.length}`,
        `approx input: ~${estimateTokens(messages, systemPrompt)} tokens`,
        `last message:\n${lastMessagePreview(messages)}`,
      ].join('\n'));
    }

    const stream = this.llmProvider.createMessage(systemPrompt, messages, providerTools, this.activeProfile ?? undefined);
    let text = '';
    let reasoning = '';
    let forwarded = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const toolCalls: StreamToolCall[] = [];
    const tracker = TokenTrackingService.getInstance();

    for await (const chunk of stream as AsyncIterable<StreamChunk>) {
      if (this.errorHandler.isExecutionCancelled()) break;
      switch (chunk.type) {
        case 'usage':
          if (chunk.inputTokens) {
            inputTokens = chunk.inputTokens;
            tracker.trackInputTokens(inputTokens, { write: chunk.cacheWriteTokens, read: chunk.cacheReadTokens });
          }
          if (chunk.outputTokens && chunk.outputTokens > outputTokens) {
            tracker.trackOutputTokens(chunk.outputTokens - outputTokens);
            outputTokens = chunk.outputTokens;
          }
          break;
        case 'reasoning':
          reasoning += chunk.reasoning ?? '';
          break;
        case 'tool_call':
          if (chunk.toolCall) toolCalls.push(chunk.toolCall);
          break;
        case 'error':
          throw new LlmStreamError(chunk.error ?? { message: 'Unknown LLM error' });
        case 'text': {
          text += chunk.text ?? '';
          // Stream visible text to the UI, holding back XML tool markup
          const cut = text.search(/(```(?:xml)?\s*)?<tool>/i);
          let safeEnd = cut >= 0 ? cut : text.length;
          const lt = text.lastIndexOf('<');
          if (cut < 0 && lt >= 0 && lt > text.length - 8) safeEnd = lt;
          if (safeEnd > forwarded) {
            callbacks.onLlmChunk?.(text.slice(forwarded, safeEnd));
            forwarded = safeEnd;
          }
          break;
        }
      }
    }

    if (this.debugMode && callbacks.onDebug) {
      const parts: string[] = [];
      if (reasoning.trim()) parts.push(`[reasoning]\n${reasoning.trim()}`);
      parts.push(`[response]\n${text || '(empty)'}`);
      if (toolCalls.length) parts.push(`[tool calls]\n${toolCalls.map(c => `${c.name} ${c.arguments}`).join('\n')}`);
      parts.push(`[tokens] in=${inputTokens} out=${outputTokens}`);
      callbacks.onDebug('← LLM response', parts.join('\n\n'));
    }
    return { text, reasoning, toolCalls };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseArguments(raw: string): string | Record<string, any> {
  const t = (raw ?? '').trim();
  if (!t) return {};
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : t;
  } catch {
    return t;
  }
}

function displayArgs(name: string, args: Record<string, any>, input: string): string {
  const shown = Object.keys(args).length === 1 && 'input' in args ? input : JSON.stringify(args);
  const masked = name === 'browser_fill_ref' && /password|pwd|pin/i.test(getMapEntry(Number(args.ref))?.label ?? '')
    ? shown.replace(/("text"\s*:\s*")[^"]*"/, '$1•••"')
    : shown;
  return masked.length > 300 ? `${masked.slice(0, 300)}…` : masked;
}

function lastMessagePreview(messages: ChatMessage[]): string {
  const m = messages[messages.length - 1];
  if (!m) return '';
  if (typeof m.content === 'string') return m.content.slice(0, 1500);
  return (m.content ?? []).map(p => (p.type === 'text' ? p.text : '[image]')).join('\n').slice(0, 1500);
}

/** Keep only user/assistant text from previous tasks (no tool-call debris). */
function sanitizeHistory(initial: any[], prompt: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of initial ?? []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (typeof m.content !== 'string' || !m.content.trim()) continue;
    if (m.role === 'assistant' && /<tool>/.test(m.content)) continue;
    out.push({ role: m.role, content: m.content });
  }
  // The current prompt is sent separately as the task message
  const last = out[out.length - 1];
  if (last && last.role === 'user' && last.content === prompt) out.pop();
  return out;
}

function buildTaskMessage(prompt: string, hints: string[] | undefined, lang: Lang): string {
  const extra = (hints ?? []).filter(h => h && h.trim());
  if (!extra.length) return prompt;
  const label = lang === 'en' ? 'Useful context' : 'Contesto utile';
  return `${prompt}\n\n[${label}]\n${extra.join('\n\n')}`;
}

const RUN_STRINGS = {
  it: {
    switchedToXml: 'ℹ️ L\'endpoint non supporta le tool call native: passo al protocollo testuale.',
    emptyResponse: 'La tua risposta precedente era vuota (probabilmente tutto è finito nel ragionamento). Il compito NON è finito: continua chiamando un tool, oppure scrivi il risultato finale.',
    emptyFailure: 'Errore: il modello ha restituito più risposte vuote consecutive. Prova un profilo con meno ragionamento o un output massimo più alto.',
    malformedCall: 'Errore di formato: la chiamata tool non è leggibile. Usa esattamente <tool>nome</tool><input>{...}</input>.',
    skippedAfterError: 'Non eseguito: la chiamata precedente è fallita. Rivaluta con il risultato ottenuto.',
    skippedAfterPageChange: 'Non eseguito: la pagina è cambiata con l\'azione precedente. Decidi il prossimo passo sulla nuova osservazione.',
    skippedAfterRejection: 'Non eseguito: l\'utente ha rifiutato l\'azione precedente.',
    cancelled: 'Non eseguito: task annullato.',
    cancelledByUser: 'Task annullato dall\'utente.',
    approvalNeeded: 'Serve la tua conferma',
    approved: 'Azione approvata, eseguo.',
    rejected: 'Azione rifiutata.',
    rejectedForModel: 'Action rejected by the user. Do not retry it: ask the user how to proceed or choose another way.',
    sessionLost: 'La sessione di controllo della pagina è stata persa: chiedi all\'utente di riprovare o apri un nuovo tab con browser_tab.',
    stepRetry: (s: number, a: number, m: number) => `⚠️ Errore di rete/LLM al passo ${s}, nuovo tentativo ${a}/${m}…`,
    maxSteps: (n: number, plan: PlanStep[]) => `Mi sono fermato dopo ${n} passi senza completare il compito.${plan.length ? ` Stato del piano: ${plan.map((p, i) => `${i + 1}. ${p.title} [${p.status}]`).join('; ')}.` : ''} Dimmi se devo continuare.`,
    fatal: (m: string) => `Errore: ${m}`,
  },
  en: {
    switchedToXml: 'ℹ️ The endpoint does not support native tool calls: switching to the text protocol.',
    emptyResponse: 'Your previous response was empty (probably everything went into reasoning). The task is NOT finished: continue by calling a tool, or write the final result.',
    emptyFailure: 'Error: the model returned several empty responses in a row. Try a profile with less reasoning or a higher max output.',
    malformedCall: 'Format error: the tool call could not be parsed. Use exactly <tool>name</tool><input>{...}</input>.',
    skippedAfterError: 'Not executed: the previous call failed. Re-evaluate with its result.',
    skippedAfterPageChange: 'Not executed: the page changed after the previous action. Decide the next step on the new observation.',
    skippedAfterRejection: 'Not executed: the user rejected the previous action.',
    cancelled: 'Not executed: task cancelled.',
    cancelledByUser: 'Task cancelled by the user.',
    approvalNeeded: 'Your confirmation is needed',
    approved: 'Action approved, executing.',
    rejected: 'Action rejected.',
    rejectedForModel: 'Action rejected by the user. Do not retry it: ask the user how to proceed or choose another way.',
    sessionLost: 'The page control session was lost: ask the user to retry or open a new tab with browser_tab.',
    stepRetry: (s: number, a: number, m: number) => `⚠️ Network/LLM error at step ${s}, retry ${a}/${m}…`,
    maxSteps: (n: number, plan: PlanStep[]) => `I stopped after ${n} steps without completing the task.${plan.length ? ` Plan status: ${plan.map((p, i) => `${i + 1}. ${p.title} [${p.status}]`).join('; ')}.` : ''} Tell me whether to continue.`,
    fatal: (m: string) => `Error: ${m}`,
  },
};
