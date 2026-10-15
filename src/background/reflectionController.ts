import { ActionLog } from '../tracking/actionLog';
import { normalizeDomain } from '../tracking/domainUtils';
import { MemoryService } from '../tracking/memoryService';
import { sendUIMessage, logWithTimestamp } from './utils';

/**
 * "Reflect and learn" (operator-initiated): stores the last task as a domain
 * memory — the request plus the sequence of actions that worked — without a
 * second LLM run over the whole conversation. Memories are injected as hints
 * at the start of later tasks on the same domain.
 */

let lastTask: { prompt: string; url: string } | null = null;

export function setLastTask(prompt: string, url: string): void {
  lastTask = { prompt, url };
}

export async function triggerReflection(tabId?: number): Promise<void> {
  try {
    if (!lastTask) {
      sendUIMessage('updateOutput', { type: 'system', content: '⚠️ Nessun task recente da memorizzare.' }, tabId);
      return;
    }
    const actions = ActionLog.snapshot();
    if (actions.length === 0) {
      sendUIMessage('updateOutput', { type: 'system', content: '⚠️ L\'ultimo task non contiene azioni da memorizzare.' }, tabId);
      return;
    }
    const domain = normalizeDomain(lastTask.url);
    const toolSequence = actions.map(a => a.description ?? a.type).slice(0, 30);
    const id = await MemoryService.getInstance().storeMemory({
      domain,
      taskDescription: lastTask.prompt.slice(0, 300),
      toolSequence,
      createdAt: Date.now(),
      validated: true,
    });
    logWithTimestamp(`Stored memory ${id} for ${domain}`);
    sendUIMessage('updateOutput', {
      type: 'system',
      content: `✅ Memoria salvata per ${domain} (${toolSequence.length} azioni). Verrà suggerita nei prossimi task su questo sito.`,
    }, tabId);
  } catch (error) {
    sendUIMessage('updateOutput', {
      type: 'system',
      content: `❌ Errore nel salvataggio della memoria: ${error instanceof Error ? error.message : String(error)}`,
    }, tabId);
  }
}
