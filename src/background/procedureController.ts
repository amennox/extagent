import { setCurrentPage } from '../agent/PageContextManager';
import { requestApproval } from '../agent/approvalManager';
import { extractWithSchema } from '../agent/tools/extractionTools';
import { toolResultText } from '../agent/tools/types';
import { getLang, Lang } from '../i18n';
import { createProvider } from '../models/providers/factory';
import { AiRequest, missingParams, ProcedureRunner, RunReport } from '../procedures/runner';
import { ProcedureStore } from '../procedures/store';
import { Procedure } from '../procedures/types';
import { beginRun, busyMessage, endRun, prepareAgent, runAgentSubtask } from './agentController';
import { ConfigManager } from './configManager';
import { attachToTab, getTabState } from './tabManager';
import { logWithTimestamp, sendUIMessage } from './utils';

/**
 * Direct execution of procedures from the UI (side panel chips, editor
 * "run until here"/"test step"). Deterministic steps run without LLM; ai steps
 * and failed steps are handed to the agent on a focused sub-task, then the
 * procedure continues.
 */

export interface RunProcedureRequest {
  procedureId: string;
  params?: Record<string, string>;
  tabId?: number;
  /** 0-based */
  startAt?: number;
  /** 0-based, inclusive */
  endAt?: number;
  mode?: 'direct' | 'test';
}

/** The web tab to act on: the given one, else the most recently used http(s) tab. */
export async function resolveTargetTab(tabId?: number): Promise<number | undefined> {
  if (tabId) return tabId;
  const tabs = await chrome.tabs.query({});
  const web = tabs
    .filter(t => t.id && t.url && /^(https?|file):/.test(t.url))
    .sort((a, b) => ((b as any).lastAccessed ?? 0) - ((a as any).lastAccessed ?? 0) || Number(b.active) - Number(a.active));
  return web[0]?.id;
}

function focusedPrompt(req: AiRequest, lang: Lang): string {
  const vars = Object.keys(req.variables).length ? JSON.stringify(req.variables).slice(0, 3000) : '';
  const next = req.procedure.steps[req.index + 1]?.description;
  if (lang === 'en') {
    return [
      `You are running the procedure "${req.procedure.name}". Do ONLY this step (${req.index + 1}/${req.procedure.steps.length}): ${req.instruction}`,
      req.failure ? `The automatic step failed: ${req.failure}. Find the right element on the current page and complete the step.` : '',
      next ? `Do not go further: the next step ("${next}") will run automatically.` : '',
      vars ? `Data available: ${vars}` : '',
      req.procedure.notes ? `Operator notes: ${req.procedure.notes}` : '',
      req.step.saveAs ? `Reply with ONLY the resulting value for "${req.step.saveAs}".` : 'When done, reply with one short sentence.',
    ].filter(Boolean).join('\n');
  }
  return [
    `Stai eseguendo la procedura "${req.procedure.name}". Esegui SOLO questo passo (${req.index + 1}/${req.procedure.steps.length}): ${req.instruction}`,
    req.failure ? `Il passo automatico è fallito: ${req.failure}. Trova l'elemento giusto nella pagina attuale e completa il passo.` : '',
    next ? `Non andare oltre: il passo successivo ("${next}") verrà eseguito automaticamente.` : '',
    vars ? `Dati disponibili: ${vars}` : '',
    req.procedure.notes ? `Note dell'operatore: ${req.procedure.notes}` : '',
    req.step.saveAs ? `Rispondi SOLO con il valore risultante per "${req.step.saveAs}".` : 'Quando hai finito rispondi con una frase breve.',
  ].filter(Boolean).join('\n');
}

async function controlledPage(tabId: number): Promise<{ page: any; tabId: number; agent: any | null } | null> {
  const prepared = await prepareAgent(tabId).catch(() => null);
  if (prepared) return { page: prepared.page, tabId: prepared.tabId, agent: prepared.agent };
  // No LLM configured: deterministic steps can still run
  let state = getTabState(tabId);
  if (!state?.page) {
    const res = await attachToTab(tabId);
    if (res && typeof res === 'object') return null;
    const newTab = typeof res === 'number' ? res : tabId;
    state = getTabState(newTab);
    if (!state?.page) return null;
    tabId = newTab;
  }
  setCurrentPage(state.page);
  return { page: state.page, tabId, agent: null };
}

export async function runProcedureDirect(req: RunProcedureRequest): Promise<RunReport | { error: string }> {
  const result = await runProcedureInner(req);
  // Early refusals (missing params, no tab…) must also release the side panel
  if ('error' in result) sendUIMessage('processingComplete', null, req.tabId);
  return result;
}

async function runProcedureInner(req: RunProcedureRequest): Promise<RunReport | { error: string }> {
  const store = ProcedureStore.getInstance();
  const proc = await store.get(req.procedureId);
  if (!proc) return { error: 'Procedure not found' };
  const lang = await getLang().catch(() => 'it' as Lang);
  const tabId = await resolveTargetTab(req.tabId);
  if (!tabId) return { error: lang === 'en' ? 'Open a web page to run the procedure on' : 'Apri una pagina web su cui eseguire la procedura' };

  const params = req.params ?? {};
  const missing = missingParams(proc, params);
  if (missing.length) return { error: `${lang === 'en' ? 'Missing parameters' : 'Parametri mancanti'}: ${missing.join(', ')}` };

  const windowId = await chrome.tabs.get(tabId).then(t => t?.windowId).catch(() => undefined);
  const run = beginRun({ kind: 'procedure', tabId, windowId });
  if (!run) return { error: busyMessage(lang) };
  const started = Date.now();
  const say = (content: string) => sendUIMessage('updateOutput', { type: 'system', content }, tabId);
  try {
    const ctl = await controlledPage(tabId);
    if (!ctl) return { error: lang === 'en' ? 'Cannot control this tab' : 'Impossibile controllare questo tab' };
    const range = req.startAt !== undefined || req.endAt !== undefined
      ? ` (${(req.startAt ?? 0) + 1}–${(req.endAt ?? proc.steps.length - 1) + 1})`
      : '';
    say(`▶ ${lang === 'en' ? 'Procedure' : 'Procedura'} "${proc.name}"${range}`);
    sendUIMessage('procedureProgress', { procedureId: proc.id, status: 'started', total: proc.steps.length }, tabId);

    const approvalMode = await ConfigManager.getInstance().getApprovalMode().catch(() => 'risky' as const);
    const provider = ctl.agent?.getLlmProvider?.() ?? await providerOrNull();
    const runner = new ProcedureRunner(ctl.page);
    const report = await runner.run(proc, {
      params,
      startAt: req.startAt,
      endAt: req.endAt,
      approvalMode,
      isCancelled: () => run.cancelled,
      onStep: (ev) => {
        sendUIMessage('procedureProgress', {
          procedureId: proc.id, index: ev.index, total: ev.total, status: ev.status,
          description: ev.step.description, message: ev.message,
        }, tabId);
        if (ev.status === 'ok') say(`✓ ${ev.index + 1}/${ev.total} ${ev.step.description}`);
        if (ev.status === 'failed') say(`✗ ${ev.index + 1}/${ev.total} ${ev.step.description}: ${ev.message ?? ''}`);
        if (ev.status === 'skipped') say(`– ${ev.index + 1}/${ev.total} ${ev.step.description} (${lang === 'en' ? 'optional, skipped' : 'facoltativo, saltato'})`);
        if (ev.status === 'agent') say(`🤖 ${ev.index + 1}/${ev.total} ${lang === 'en' ? 'the agent takes over' : 'subentra l\'agente'}: ${ev.message ?? ev.step.description}`);
      },
      onApproval: (step, reason) => requestApproval(tabId, 'procedure', `${proc.name}: ${step.description}`, reason),
      extract: provider
        ? async (schema, hint) => toolResultText(await extractWithSchema(ctl.page, provider).func(JSON.stringify({ schema, hint })))
        : undefined,
      aiResolver: ctl.agent
        ? async (aiReq) => {
          const result = await runAgentSubtask(ctl.tabId, focusedPrompt(aiReq, lang), 20);
          return { ok: result?.outcome === 'success', output: result?.finalText };
        }
        : undefined,
    });

    await store.recordRun(proc.id, {
      at: started,
      outcome: report.status === 'success' ? 'success' : report.status === 'cancelled' ? 'cancelled' : report.status === 'needs_agent' ? 'needs_agent' : 'failure',
      mode: req.mode === 'test' ? 'test' : 'direct',
      failedStep: report.stoppedAt,
      error: report.error,
      durationMs: Date.now() - started,
      stepsDone: report.stepsDone,
    }).catch(() => undefined);

    say(summary(proc, report, lang));
    sendUIMessage('procedureProgress', { procedureId: proc.id, status: 'finished', result: report.status, stoppedAt: report.stoppedAt }, tabId);
    return report;
  } catch (err) {
    logWithTimestamp(`Procedure run failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    endRun(run);
    sendUIMessage('processingComplete', null, tabId);
  }
}

function summary(proc: Procedure, r: RunReport, lang: Lang): string {
  const vars = Object.keys(r.variables).length ? `\n${JSON.stringify(r.variables, null, 2).slice(0, 2000)}` : '';
  if (lang === 'en') {
    switch (r.status) {
      case 'success': return `✅ "${proc.name}" completed (${r.stepsDone} steps).${vars}`;
      case 'cancelled': return `⏹ "${proc.name}" cancelled.`;
      case 'rejected': return `⏹ "${proc.name}" stopped: step ${(r.stoppedAt ?? 0) + 1} rejected.`;
      case 'needs_agent': return `⚠️ "${proc.name}" stopped at step ${(r.stoppedAt ?? 0) + 1}: it needs the agent (configure an LLM provider). ${r.error ?? ''}`;
      default: return `❌ "${proc.name}" failed at step ${(r.stoppedAt ?? 0) + 1}: ${r.error ?? ''}`;
    }
  }
  switch (r.status) {
    case 'success': return `✅ "${proc.name}" completata (${r.stepsDone} passi).${vars}`;
    case 'cancelled': return `⏹ "${proc.name}" annullata.`;
    case 'rejected': return `⏹ "${proc.name}" fermata: passo ${(r.stoppedAt ?? 0) + 1} rifiutato.`;
    case 'needs_agent': return `⚠️ "${proc.name}" fermata al passo ${(r.stoppedAt ?? 0) + 1}: serve l'agente (configura un provider LLM). ${r.error ?? ''}`;
    default: return `❌ "${proc.name}" fallita al passo ${(r.stoppedAt ?? 0) + 1}: ${r.error ?? ''}`;
  }
}

async function providerOrNull() {
  try {
    const cfg = ConfigManager.getInstance();
    const config = await cfg.getProviderConfig();
    if (!config.apiKey) return null;
    return createProvider({
      apiKey: config.apiKey,
      apiModelId: config.apiModelId,
      baseUrl: config.baseUrl,
      openaiCompatibleModels: config.openaiCompatibleModels,
      profiles: await cfg.getProfiles().catch(() => []),
      defaultProfileId: await cfg.getDefaultProfileId().catch(() => ''),
      dangerouslyAllowBrowser: true,
    });
  } catch {
    return null;
  }
}

/**
 * AI help in the editor: propose name, description and parameters for a
 * procedure from its steps (one LLM call).
 */
export async function analyzeProcedure(procedureId: string): Promise<{ name?: string; description?: string; params?: Array<{ stepIndex: number; name: string; label?: string }> } | { error: string }> {
  const proc = await ProcedureStore.getInstance().get(procedureId);
  if (!proc) return { error: 'Procedure not found' };
  const provider = await providerOrNull();
  if (!provider) return { error: 'LLM provider not configured' };
  const lang = await getLang().catch(() => 'it' as Lang);
  const steps = proc.steps.map((s, i) => `${i}. [${s.type}] ${s.description}${s.target?.label ? ` (campo: ${s.target.label})` : ''}${s.value ? ` valore: "${s.value}"` : ''}`).join('\n');
  const instruction = lang === 'en'
    ? 'Analyze this recorded web procedure. Reply ONLY with JSON: {"name": "short name", "description": "what it does, one sentence", "params": [{"stepIndex": <0-based>, "name": "snake_case", "label": "human label"}]}. Parameters: values that would change between runs (search terms, codes, dates, quantities). Never passwords.'
    : 'Analizza questa procedura web registrata. Rispondi SOLO con JSON: {"name": "nome breve", "description": "cosa fa, una frase", "params": [{"stepIndex": <0-based>, "name": "snake_case", "label": "etichetta leggibile"}]}. Parametri: valori che cambierebbero tra un\'esecuzione e l\'altra (termini di ricerca, codici, date, quantità). Mai password.';
  let text = '';
  for await (const chunk of provider.createMessage(instruction, [{ role: 'user', content: `${proc.name}\n${steps}` }], undefined, undefined, { response_format: { type: 'json_object' } })) {
    if (chunk.type === 'text' && chunk.text) text += chunk.text;
    if (chunk.type === 'error') return { error: chunk.error?.message ?? 'LLM error' };
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
      params: Array.isArray(parsed.params)
        ? parsed.params.filter((p: any) => typeof p?.stepIndex === 'number' && typeof p?.name === 'string')
        : undefined,
    };
  } catch {
    return { error: 'Could not parse the AI suggestion' };
  }
}
