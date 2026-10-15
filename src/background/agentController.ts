import { BrowserAgent, createBrowserAgent, executePromptWithFallback } from "../agent/AgentCore";
import type { PlanStep } from "../agent/AgentState";
import { ExecutionCallbacks, RunResult } from "../agent/ExecutionEngine";
import { setCurrentPage } from "../agent/PageContextManager";
import { contextTokenCount } from "../agent/TokenManager";
import { DomainProfileManager } from "../agent/domainProfileManager";
import { profilePage, profileSummary, playbookFor } from "../agent/pageProfiler";
import { getLang, Lang, t } from "../i18n";
import type { ChatMessage } from "../models/providers/types";
import { buildProcedure, CapturedAction } from "../procedures/builder";
import { ProcedureStore } from "../procedures/store";
import type { Procedure } from "../procedures/types";
import { ActionLog } from "../tracking/actionLog";
import { MemoryService } from "../tracking/memoryService";
import { TokenTrackingService } from "../tracking/tokenTrackingService";
import { ConfigManager } from "./configManager";
import { setLastTask } from "./reflectionController";
import {
  resetStreamingState,
  addToStreamingBuffer,
  getStreamingBuffer,
  setStreamingBuffer,
  clearStreamingBuffer,
  finalizeStreamingSegment,
  startNewSegment,
  getCurrentSegmentId,
  incrementSegmentId,
  signalStreamingComplete
} from "./streamingManager";
import {
  getCurrentTabId,
  getTabState,
  getWindowForTab,
  getAgentForWindow,
  setAgentForWindow,
  isConnectionHealthy
} from "./tabManager";
import { AgentStatus, AgentStatusInfo } from "./types";
import { sendUIMessage, logWithTimestamp, handleError } from "./utils";

/**
 * Cross-task conversation per window: ONLY the user requests and the final
 * answers. Intermediate tool calls never leak into the next task (they used to
 * appear as orphan tool calls and confused the model).
 */
const windowHistories = new Map<number, ChatMessage[]>();
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_TOKENS = 6_000;

/** Last task per window: memories in play (feedback) and actions (save as procedure) */
interface LastTaskInfo {
  domain: string;
  url: string;
  prompt: string;
  memoryIds: number[];
  actions: CapturedAction[];
  outcome?: string;
}
const lastTaskInfoByWindow = new Map<number, LastTaskInfo>();

/**
 * Apply explicit operator feedback (👍/👎) to the memories used in the last
 * task of this window: 👍 validates them, 👎 removes provisional ones and
 * weakens validated ones.
 */
export async function applyTaskFeedback(windowId: number, positive: boolean): Promise<{ affected: number }> {
  const info = lastTaskInfoByWindow.get(windowId);
  if (!info?.memoryIds?.length) return { affected: 0 };
  const service = MemoryService.getInstance();
  if (positive) {
    await service.reinforceMemories(info.memoryIds, true);
  } else {
    await service.penalizeMemories(info.memoryIds);
  }
  return { affected: info.memoryIds.length };
}

// ── Agent status ──────────────────────────────────────────────────────────

const agentStatusMap = new Map<number, AgentStatusInfo>();

export function setAgentStatus(windowId: number, status: AgentStatus): void {
  const current = agentStatusMap.get(windowId);
  const now = Date.now();
  agentStatusMap.set(windowId, { status, timestamp: now, lastHeartbeat: now });
  if (!current || current.status !== status) {
    logWithTimestamp(`Agent status transition: ${current?.status || 'undefined'} -> ${status} for window ${windowId}`);
  }
}

export function updateAgentHeartbeat(windowId: number): void {
  const current = agentStatusMap.get(windowId);
  if (current && current.status === AgentStatus.RUNNING) {
    agentStatusMap.set(windowId, { ...current, lastHeartbeat: Date.now() });
  }
}

export function getAgentStatus(windowId: number): AgentStatusInfo {
  return agentStatusMap.get(windowId) || { status: AgentStatus.IDLE, timestamp: Date.now(), lastHeartbeat: 0 };
}

// ── History ───────────────────────────────────────────────────────────────

export async function clearMessageHistory(tabId?: number, windowId?: number): Promise<void> {
  if (tabId && !windowId) windowId = getWindowForTab(tabId);
  if (!windowId && getCurrentTabId()) windowId = getWindowForTab(getCurrentTabId()!);
  if (windowId) {
    windowHistories.delete(windowId);
    logWithTimestamp(`Message history cleared for window ${windowId}`);
  } else {
    windowHistories.clear();
    logWithTimestamp('All message histories cleared');
  }
}

/** Conversation history (user requests + final answers) for the tab's window. */
export async function getMessageHistory(tabId: number): Promise<ChatMessage[]> {
  const windowId = getWindowForTab(tabId);
  return windowId ? [...(windowHistories.get(windowId) ?? [])] : [];
}

function appendHistory(windowId: number, prompt: string, answer: string): void {
  const history = windowHistories.get(windowId) ?? [];
  history.push({ role: 'user', content: prompt }, { role: 'assistant', content: answer || '(nessuna risposta)' });
  while (history.length > MAX_HISTORY_MESSAGES || (history.length > 2 && contextTokenCount(history) > MAX_HISTORY_TOKENS)) {
    history.splice(0, 2);
  }
  windowHistories.set(windowId, history);
}

// ── Agent lifecycle ───────────────────────────────────────────────────────

export async function initializeAgent(tabId: number, forceReinit: boolean = false): Promise<boolean> {
  const tabState = getTabState(tabId);
  if (!tabState?.page || !tabState.windowId) return false;
  const windowId = tabState.windowId;

  const configManager = ConfigManager.getInstance();
  const providerConfig = await configManager.getProviderConfig();
  TokenTrackingService.getInstance().updateProviderAndModel(providerConfig.provider, providerConfig.apiModelId || '');

  const existingAgent = getAgentForWindow(windowId);
  // Recreate the agent each time it is (re)initialized so provider/profile
  // changes in the options take effect; tasks reuse it via prepareAgent().
  if (existingAgent && !forceReinit) return true;

  try {
    if (!providerConfig.apiKey) {
      logWithTimestamp('No API key configured, skipping agent initialization', 'warn');
      return false;
    }
    const agent = await createBrowserAgent(tabState.page, providerConfig.apiKey);
    setAgentForWindow(windowId, agent);
    try {
      const pageUrl = await tabState.page.url();
      const profile = await DomainProfileManager.getInstance().matchProfileForUrl(pageUrl);
      await DomainProfileManager.getInstance().setActiveProfileName(profile?.display_name ?? null);
      agent.promptManager.setProfileAddendum(profile?.system_prompt_addendum ?? '');
    } catch {
      // page URL not available yet
    }
    logWithTimestamp(`LLM agent created for window ${windowId}`);
    return true;
  } catch (agentError) {
    handleError(agentError, 'creating agent');
    return false;
  }
}

export function cancelExecution(tabId?: number): void {
  if (!tabId) {
    const currentTabId = getCurrentTabId();
    if (!currentTabId) return;
    tabId = currentTabId;
  }
  const windowId = getWindowForTab(tabId);
  if (!windowId) return;
  getAgentForWindow(windowId)?.cancel();
  cancelHooks.forEach(fn => { try { fn(); } catch { /* ignore */ } });
  sendUIMessage('updateOutput', { type: 'system', content: 'Cancelling execution...' }, tabId);
  sendUIMessage('processingComplete', null, tabId);
  setAgentStatus(windowId, AgentStatus.IDLE);
}

/** Other runners (procedures) register here to be stopped by the Stop button. */
const cancelHooks = new Set<() => void>();
export function onCancel(fn: () => void): () => void {
  cancelHooks.add(fn);
  return () => cancelHooks.delete(fn);
}

/** Provider/profile settings the agent was created with, per window. */
const agentFingerprints = new Map<number, string>();

async function configFingerprint(): Promise<string> {
  const cfg = ConfigManager.getInstance();
  const [provider, profiles, defaultId] = await Promise.all([
    cfg.getProviderConfig().catch(() => null),
    cfg.getProfiles().catch(() => []),
    cfg.getDefaultProfileId().catch(() => ''),
  ]);
  return JSON.stringify({ b: provider?.baseUrl, k: provider?.apiKey?.slice(-6), m: provider?.apiModelId, profiles, defaultId });
}

export interface PreparedAgent {
  agent: BrowserAgent;
  page: any;
  tabId: number;
  windowId: number;
  url: string;
  title: string;
}

/**
 * Attach to the tab (or reattach after a lost debugger session), make sure an
 * agent exists for its window and refresh the page context. Reports problems
 * to the side panel and returns null when the tab cannot be controlled.
 */
export async function prepareAgent(tabId?: number): Promise<PreparedAgent | null> {
  const providerConfig = await ConfigManager.getInstance().getProviderConfig();
  const lang = await getLang().catch(() => 'it' as Lang);
  if (!providerConfig.apiKey) {
    sendUIMessage('updateOutput', { type: 'system', content: t('error.apiKeyMissing', lang) }, tabId);
    return null;
  }

  let targetTabId = tabId;
  if (!targetTabId) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    targetTabId = tabs[0]?.id;
  }
  if (!targetTabId) {
    sendUIMessage('updateOutput', { type: 'system', content: 'Error: Could not determine which tab to use.' }, tabId);
    return null;
  }

  const tabState = getTabState(targetTabId);
  const fingerprint = await configFingerprint();
  const staleConfig = !!tabState?.windowId && agentFingerprints.get(tabState.windowId) !== fingerprint;
  const needsInitialization = !tabState?.page || !tabState.windowId || !getAgentForWindow(tabState.windowId) || staleConfig;
  const connectionBroken = tabState?.page && !(await isConnectionHealthy(tabState.page));

  if (needsInitialization || connectionBroken) {
    sendUIMessage('updateOutput', {
      type: 'system',
      content: connectionBroken ? 'Debug session was closed, reattaching...' : 'Initializing for tab...',
    }, targetTabId);
    const { attachToTab } = await import('./tabManager');
    const attachResult = tabState?.page && !connectionBroken ? true : await attachToTab(targetTabId);
    if (attachResult && typeof attachResult === 'object' && 'error' in attachResult) {
      sendUIMessage('updateOutput', {
        type: 'system',
        content: `Error: ${(attachResult as any).reason} Please try using the extension in a regular web page tab.`,
      }, targetTabId);
      return null;
    }
    if (typeof attachResult === 'number') targetTabId = attachResult;
    await initializeAgent(targetTabId, true);
    const ws = getTabState(targetTabId)?.windowId;
    if (ws) agentFingerprints.set(ws, fingerprint);
  }

  const state = getTabState(targetTabId);
  const agent = state?.windowId ? getAgentForWindow(state.windowId) : undefined;
  if (!state?.page || !state.windowId || !agent) {
    sendUIMessage('updateOutput', {
      type: 'system',
      content: 'Error: Failed to initialize Playwright or create agent. This may be because you are using the extension in an unsupported tab type.',
    }, targetTabId);
    return null;
  }

  try { setCurrentPage(state.page); } catch { /* ignore */ }

  let url = '';
  let title = '';
  try {
    url = await state.page.url();
    title = await state.page.title();
    let playbook = '';
    let profileNote = '';
    try {
      const pageProfile = await profilePage(state.page);
      if (pageProfile) {
        profileNote = ` · ${profileSummary(pageProfile)}`;
        playbook = playbookFor(pageProfile, lang === 'en' ? 'en' : 'it');
      }
    } catch { /* best effort */ }
    agent.promptManager.setCurrentPageContext(url, title);
    agent.promptManager.setPagePlaybook(playbook);
    sendUIMessage('updateOutput', { type: 'system', content: `Current page: ${url} (${title})${profileNote}` }, targetTabId);
  } catch (error) {
    logWithTimestamp('Could not get current page info: ' + String(error), 'warn');
  }

  try {
    const cfg = ConfigManager.getInstance();
    agent.setDebugMode(await cfg.getDebugMode());
    agent.setMaxSteps(await cfg.getMaxSteps());
  } catch { /* non-blocking */ }

  return { agent, page: state.page, tabId: targetTabId, windowId: state.windowId, url, title };
}

/** UI callbacks: streaming text, tool lines, screenshots, debug traces. */
export function createUiCallbacks(targetTabId: number, onFinal?: (text: string) => void): ExecutionCallbacks {
  return {
    onLlmChunk: (chunk) => {
      addToStreamingBuffer(chunk, targetTabId, getWindowForTab(targetTabId));
    },
    onLlmOutput: (content) => {
      setStreamingBuffer(content);
      onFinal?.(content);
    },
    onToolOutput: (content) => {
      sendUIMessage('updateOutput', { type: 'system', content }, targetTabId);
    },
    onDebug: (label, detail) => {
      sendUIMessage('updateOutput', { type: 'debug', debugLabel: label, content: detail }, targetTabId);
    },
    onToolImage: (image, note) => {
      sendUIMessage('updateScreenshot', {
        type: 'screenshot',
        content: note || 'Screenshot',
        imageData: image.data,
        mediaType: image.mediaType,
      }, targetTabId);
    },
    onError: (error) => {
      logWithTimestamp(`Agent error: ${error instanceof Error ? error.message : String(error)}`, 'warn');
    },
    onSegmentComplete: (segment) => {
      const windowId = getWindowForTab(targetTabId);
      finalizeStreamingSegment(getCurrentSegmentId(), segment, targetTabId, windowId);
      setStreamingBuffer('');
      incrementSegmentId();
    },
    onToolStart: () => {
      startNewSegment(getCurrentSegmentId(), targetTabId, getWindowForTab(targetTabId));
    },
    onComplete: () => {
      const windowId = getWindowForTab(targetTabId);
      if (getStreamingBuffer().trim()) {
        finalizeStreamingSegment(getCurrentSegmentId(), getStreamingBuffer(), targetTabId, windowId);
        setStreamingBuffer('');
      }
      clearStreamingBuffer(targetTabId, windowId);
      signalStreamingComplete(targetTabId, windowId);
    },
  };
}

async function proceduresHint(url: string, lang: Lang): Promise<string | null> {
  try {
    const procs = (await ProcedureStore.getInstance().listForDomain(url)).slice(0, 10);
    if (!procs.length) return null;
    const lines = procs.map(p => {
      const params = p.params.map(x => `${x.name}${x.required ? '' : '?'}${x.type === 'secret' ? ' (secret)' : ''}`).join(', ');
      return `- "${p.name}"${p.description ? `: ${p.description}` : ''}${params ? ` · params: ${params}` : ''}`;
    });
    return lang === 'en'
      ? `Saved procedures for this site (run them with run_procedure when they match the request):\n${lines.join('\n')}`
      : `Procedure salvate per questo sito (eseguile con run_procedure quando corrispondono alla richiesta):\n${lines.join('\n')}`;
  } catch {
    return null;
  }
}

/**
 * Run a user request with the agent on the given tab.
 */
export async function executePrompt(prompt: string, tabId?: number): Promise<void> {
  let prepared: PreparedAgent | null = null;
  try {
    prepared = await prepareAgent(tabId);
    if (!prepared) {
      sendUIMessage('processingComplete', null, tabId);
      return;
    }
    const { agent, tabId: targetTabId, windowId, url } = prepared;
    const lang = await getLang().catch(() => 'it' as Lang);
    const config = ConfigManager.getInstance();

    sendUIMessage('updateOutput', { type: 'system', content: `Executing prompt: "${prompt}"` }, targetTabId);
    setAgentStatus(windowId, AgentStatus.RUNNING);
    resetStreamingState();

    // Context for the first message: memories and procedures for this site
    const hints: string[] = [];
    let memoryIds: number[] = [];
    let domain = '';
    try { domain = new URL(url).hostname; } catch { /* non-http page */ }
    if (domain) {
      const memory = await agent.memoryHintForDomain(domain, lang === 'en' ? 'en' : 'it').catch(() => null);
      if (memory) { hints.push(memory.hint); memoryIds = memory.ids; }
      const procs = await proceduresHint(url, lang);
      if (procs) hints.push(procs);
    }

    // Explicit plan for long multi-step requests (one LLM call), shown as a
    // live checklist in the [STATE] message
    let initialPlan: PlanStep[] | undefined;
    if (prompt.length >= 120 && await config.getPlanningEnabled().catch(() => true)) {
      const plan = await agent.generatePlan(prompt, lang === 'en' ? 'en' : 'it').catch(() => null);
      if (plan) {
        initialPlan = plan;
        sendUIMessage('updateOutput', { type: 'system', content: `📋 ${plan.map((p, i) => `${i + 1}. ${p.title}`).join(' · ')}` }, targetTabId);
      }
    }

    ActionLog.reset();
    setLastTask(prompt, url);
    const history = await getMessageHistory(targetTabId);
    const callbacks = createUiCallbacks(targetTabId);

    const result: RunResult = await executePromptWithFallback(agent, prompt, callbacks, history, 'automation', { taskHints: hints, initialPlan });

    appendHistory(windowId, prompt, result.finalText);
    const actions = ActionLog.snapshot();
    lastTaskInfoByWindow.set(windowId, { domain, url, prompt, memoryIds, actions, outcome: result.outcome });

    sendUIMessage('taskOutcome', {
      outcome: result.outcome,
      canSaveProcedure: result.outcome === 'success' && actions.filter(a => a.type !== 'navigate').length >= 2,
    }, targetTabId, windowId);
    if (result.outcome === 'success' && memoryIds.length) {
      await MemoryService.getInstance().reinforceMemories(memoryIds).catch(() => undefined);
    }
    setAgentStatus(windowId, AgentStatus.IDLE);
    sendUIMessage('processingComplete', null, targetTabId, windowId);
  } catch (error) {
    const errorMessage = handleError(error, 'executing prompt');
    sendUIMessage('updateOutput', { type: 'system', content: `Error: ${errorMessage}` }, tabId);
    if (prepared) setAgentStatus(prepared.windowId, AgentStatus.IDLE);
    sendUIMessage('processingComplete', null, tabId);
  }
}

/**
 * Run the agent on a focused sub-task (procedure ai steps / failed steps).
 * Shares the UI callbacks; does not touch the cross-task history.
 */
export async function runAgentSubtask(tabId: number, prompt: string, maxSteps = 20): Promise<RunResult | null> {
  const prepared = await prepareAgent(tabId);
  if (!prepared) return null;
  resetStreamingState();
  const callbacks = createUiCallbacks(prepared.tabId);
  return executePromptWithFallback(prepared.agent, prompt, callbacks, [], 'automation', { maxSteps });
}

/** Build a procedure from the actions of the last successful task of the window. */
export async function saveLastTaskAsProcedure(windowId: number, name?: string): Promise<Procedure | null> {
  const info = lastTaskInfoByWindow.get(windowId);
  if (!info || info.actions.length === 0) return null;
  const proc = buildProcedure(info.actions, {
    name: name || info.prompt.replace(/\s+/g, ' ').slice(0, 60),
    description: info.prompt.slice(0, 300),
    source: 'agent',
    startUrl: info.url || undefined,
  });
  return ProcedureStore.getInstance().save(proc);
}
