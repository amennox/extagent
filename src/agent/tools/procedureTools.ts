import type { Page } from "playwright-crx";
import { ConfigManager } from "../../background/configManager";
import { LLMProvider } from "../../models/providers/types";
import { formatRunReport, ProcedureRunner } from "../../procedures/runner";
import { ProcedureStore } from "../../procedures/store";
import { requestApproval } from "../approvalManager";
import { extractWithSchema } from "./extractionTools";
import { observePage } from "./pageMapTools";
import { ToolExecutionContext, ToolOutput, toolResultText } from "./types";
import { getCurrentTabId, withActivePage } from "./utils";

/**
 * run_procedure — runs a saved procedure deterministically inside the agent
 * loop. When a step needs judgement (ai step) or fails, the tool returns a
 * resumable report: the agent completes that step with the browser tools and
 * calls run_procedure again with startAt.
 */
export function runProcedure(page: Page, llmProvider?: LLMProvider) {
  return {
    name: 'run_procedure',
    description: 'Run a saved procedure. Input: JSON {name, params?, startAt?}.',
    func: async (input: string, context?: ToolExecutionContext): Promise<string | ToolOutput> => {
      let args: { name?: string; params?: Record<string, unknown>; startAt?: number };
      try {
        args = JSON.parse(input || '{}');
      } catch {
        args = { name: input };
      }
      const name = String(args.name ?? '').trim();
      if (!name) return 'Error: "name" is required.';
      const store = ProcedureStore.getInstance();
      const proc = await store.findByName(name);
      if (!proc) {
        const available = (await store.list()).map(p => p.name);
        return `Error: procedure "${name}" not found.${available.length ? ` Available: ${available.slice(0, 20).join(', ')}` : ' No procedures are saved: do the task with the browser tools.'}`;
      }
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(args.params ?? {})) params[k] = String(v);
      const approvalMode = await ConfigManager.getInstance().getApprovalMode().catch(() => 'risky' as const);
      const started = Date.now();

      return withActivePage(page, async (activePage) => {
        const runner = new ProcedureRunner(activePage);
        const report = await runner.run(proc, {
          params,
          startAt: args.startAt ? Math.max(0, Number(args.startAt) - 1) : 0,
          approvalMode,
          isCancelled: context?.isCancelled,
          onApproval: async (step, reason) => {
            const tabId = (await getCurrentTabId(activePage)) ?? 0;
            return requestApproval(tabId, 'run_procedure', `${proc.name}: ${step.description}`, reason);
          },
          extract: llmProvider
            ? async (schema, hint) => toolResultText(await extractWithSchema(activePage, llmProvider).func(JSON.stringify({ schema, hint })))
            : undefined,
        });
        await store.recordRun(proc.id, {
          at: started,
          outcome: report.status === 'success' ? 'success' : report.status === 'needs_agent' ? 'needs_agent' : report.status === 'cancelled' ? 'cancelled' : 'failure',
          mode: 'agent',
          failedStep: report.stoppedAt,
          error: report.error,
          durationMs: Date.now() - started,
          stepsDone: report.stepsDone,
        }).catch(() => undefined);

        if (report.missingParams?.length) {
          const descr = proc.params
            .filter(p => report.missingParams!.includes(p.name))
            .map(p => `${p.name}${p.label ? ` (${p.label})` : ''}${p.type === 'secret' ? ' [secret: ask the user]' : ''}`)
            .join(', ');
          return `Error: procedure "${proc.name}" needs these parameters: ${descr}. Ask the user for the values you cannot infer from the request.`;
        }
        const text = formatRunReport(proc, report);
        if (report.status === 'success' || report.status === 'needs_agent') {
          const obs = await observePage(activePage).catch(() => null);
          if (obs) return { ...obs, text: `${text}\n\n${obs.text}` };
        }
        return text;
      });
    },
  };
}
