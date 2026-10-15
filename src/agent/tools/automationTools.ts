import type { Page } from "playwright-crx";
import { RecordingManager } from "../../background/recordingManager";
import { requestApproval } from "../approvalManager";
import { ReplayEngine } from "../replay/ReplayEngine";
import { createReplayContext } from "../replay/expressionResolver";
import { getCurrentTabId, withActivePage } from "./utils";

/**
 * play_automation — DETERMINISTIC replay of a recorded sequence.
 *
 * Steps are executed directly via playwright using the recorded locator
 * bundle (no LLM in the happy path). {{…}} expressions in typed text are
 * resolved from params / dates. Risky steps (submit/delete-like) request
 * explicit user approval. On failure the tool returns a structured report
 * with the failed step and the remaining steps so the agent can take over
 * manually from that point.
 */
export function playAutomation(page: Page) {
  return {
    name: 'play_automation',
    description: 'Replay a recorded automation sequence deterministically. Input: JSON {recordingName, params?, instruction?}.',
    func: async (input: string): Promise<string> => {
      let parsed: { recordingName: string; params?: Record<string, string>; instruction?: string; confirmBeforeEachStep?: boolean };
      try {
        parsed = JSON.parse(input);
      } catch {
        return JSON.stringify({ success: false, stepsExecuted: 0, errors: ['Invalid JSON input'] });
      }

      const { recordingName, params = {}, instruction } = parsed;
      const manager = RecordingManager.getInstance();
      const recording = await manager.getRecording(recordingName);

      if (!recording) {
        // List what actually exists so the model stops inventing names
        const available = await Promise.resolve()
          .then(() => manager.listRecordings())
          .then(list => list.map(r => r.name))
          .catch(() => [] as string[]);
        return JSON.stringify({
          success: false,
          stepsExecuted: 0,
          errors: [`Recording not found: "${recordingName}"`],
          availableRecordings: available,
          hint: available.length === 0
            ? 'No recordings exist. Do NOT call play_automation again — perform the task manually with browser_interactive_map and the _ref tools.'
            : 'Use one of availableRecordings exactly as listed, or perform the task manually.',
        });
      }

      return withActivePage(page, async (activePage) => {
        const engine = new ReplayEngine(activePage);
        const context = createReplayContext(params);

        const result = await engine.play(recording, {
          context,
          onApprovalNeeded: async (step, reason) => {
            try {
              const tabId = await getCurrentTabId(activePage) ?? 0;
              return await requestApproval(tabId, 'play_automation', step.description ?? step.type, reason);
            } catch {
              return false;
            }
          },
        });

        if (result.success) {
          return JSON.stringify({
            success: true,
            stepsExecuted: result.stepsExecuted,
            totalSteps: result.totalSteps,
            log: result.results.map(r => `${r.index + 1}. [${r.status}] ${r.description}${r.resolvedText ? ` → "${r.resolvedText}"` : ''}`),
            errors: [],
          });
        }

        // Structured failure report: the agent LLM can continue manually
        const remaining = (result.remainingSteps ?? [])
          .map((s, i) => `${result.failedStep!.index + i + 2}. [${s.type}] ${s.description ?? s.selector ?? s.url ?? ''}${s.text ? ` → "${s.text}"` : ''}`)
          .join('\n');

        return JSON.stringify({
          success: false,
          stepsExecuted: result.stepsExecuted,
          totalSteps: result.totalSteps,
          log: result.results.map(r => `${r.index + 1}. [${r.status}] ${r.description}${r.error ? ` — ${r.error}` : ''}`),
          errors: [result.results.find(r => r.status !== 'ok')?.error ?? 'Replay failed'],
          failedStep: {
            index: result.failedStep!.index + 1,
            type: result.failedStep!.type,
            description: result.failedStep!.description,
            selector: result.failedStep!.selector,
            candidates: result.failedStep!.candidates,
            elementText: result.failedStep!.elementText,
            elementLabel: result.failedStep!.elementLabel,
          },
          recovery: [
            `Deterministic replay failed at step ${result.failedStep!.index + 1} of ${result.totalSteps}.`,
            instruction ? `Operator instructions: ${instruction}` : null,
            'Inspect the current page (browser_accessible_tree or browser_read_text), complete the failed step manually with browser tools, then continue with the remaining steps:',
            remaining || '(no remaining steps)',
          ].filter(Boolean).join('\n'),
        });
      });
    },
  };
}
