import type { Page } from "playwright-crx";
import { LLMProvider } from "../../models/providers/types";
import { RecordingManager } from "../../background/recordingManager";
import { SkillManager, ParsedStep } from "../skillManager";
import { requestApproval } from "../approvalManager";
import { ReplayEngine } from "../replay/ReplayEngine";
import { createReplayContext, resolveExpressions, ReplayContext } from "../replay/expressionResolver";
import { extractWithSchema, paginateAndCollect } from "./extractionTools";
import { fillFormFromData } from "./formTools";
import { getCurrentTabId, withActivePage } from "./utils";

interface StepLogEntry {
  index: number;
  type: string;
  status: 'ok' | 'failed';
  detail?: string;
}

async function consumeText(stream: AsyncIterable<any>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.text) text += chunk.text;
  }
  return text;
}

/**
 * compute: step (Level 2) — one targeted LLM call producing a single value.
 */
async function runCompute(
  llmProvider: LLMProvider,
  instruction: string,
  ctx: ReplayContext
): Promise<string> {
  const { resolved } = resolveExpressions(instruction, ctx);
  const stream = llmProvider.createMessage(
    'You compute a single value from the given data. Return ONLY the value itself: no explanations, no quotes, no markdown.',
    [{ role: 'user', content: resolved }],
    undefined,
    undefined
  );
  return (await consumeText(stream)).trim();
}

/**
 * use_skill — HYBRID skill runner.
 *
 * Deterministic where possible: navigate/play run directly via playwright,
 * extract/paginate/fill reuse the dedicated tools, {{…}} expressions resolve
 * without LLM (dates, params, variables from previous steps). `compute:`
 * steps make ONE targeted LLM call each. Free-text lines in the skill body
 * are returned as operator instructions so the agent LLM can apply them when
 * something unexpected happens.
 *
 * On step failure the tool returns a structured report (completed steps,
 * failed step, remaining steps, notes) and the agent continues manually.
 */
export function useSkill(page: Page, llmProvider?: LLMProvider) {
  return {
    name: 'use_skill',
    description: 'Execute a saved skill by title: deterministic steps (navigate, play, extract, paginate, fill, compute, export) with {{param}} substitution. Input: JSON {skillTitle, params?}.',
    func: async (input: string): Promise<string> => {
      let parsed: { skillTitle: string; params?: Record<string, string> };
      try {
        parsed = JSON.parse(input);
      } catch {
        return JSON.stringify({ success: false, stepsExecuted: 0, errors: ['Invalid JSON input'] });
      }

      const { skillTitle, params = {} } = parsed;
      const manager = SkillManager.getInstance();
      const skill = await manager.getSkill(skillTitle);

      if (!skill) {
        return JSON.stringify({
          success: false,
          stepsExecuted: 0,
          errors: [`Skill not found: "${skillTitle}"`],
        });
      }

      const ctx = createReplayContext(params);
      const log: StepLogEntry[] = [];
      const exports: Array<{ format: string; data: unknown }> = [];
      const steps = skill.steps;

      const report = (success: boolean, errors: string[], failedIndex?: number) => {
        const payload: Record<string, unknown> = {
          success,
          skill: skill.title,
          stepsExecuted: log.filter(l => l.status === 'ok').length,
          totalSteps: steps.length,
          log,
          errors,
        };
        // Expose collected variables (trimmed) so the agent can use them
        const vars: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(ctx.variables)) {
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          vars[k] = s.length > 4000 ? s.slice(0, 4000) + '…[truncated]' : v;
        }
        if (Object.keys(vars).length) payload.variables = vars;
        if (exports.length) payload.exports = exports;
        if (skill.notes?.length) payload.operatorNotes = skill.notes;
        if (!success && failedIndex !== undefined) {
          const remaining = steps.slice(failedIndex + 1).map(s => s.raw);
          payload.recovery = [
            `Skill execution failed at step ${failedIndex + 1} of ${steps.length}.`,
            skill.notes?.length ? `Operator notes: ${skill.notes.join(' | ')}` : null,
            remaining.length ? `Complete the failed step manually with browser tools, then continue with:\n${remaining.join('\n')}` : 'This was the last step.',
          ].filter(Boolean).join('\n');
        }
        return JSON.stringify(payload);
      };

      // No structured steps → legacy behavior: return the body as instructions
      if (steps.length === 0) {
        const bodyMatch = skill.raw.match(/^---[\s\S]*?---\n([\s\S]*)$/);
        let body = bodyMatch ? bodyMatch[1].trim() : '';
        for (const [k, v] of Object.entries(params)) {
          body = body.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
        }
        return [
          `SKILL: "${skill.title}" — ${skill.description}`,
          '',
          'FOLLOW THESE INSTRUCTIONS EXACTLY, in order, using the appropriate browser tools:',
          '',
          body,
        ].join('\n');
      }

      for (let i = 0; i < steps.length; i++) {
        const step: ParsedStep = steps[i];
        const { resolved: payload } = resolveExpressions(step.payload, ctx);

        try {
          switch (step.type) {
            case 'navigate': {
              await withActivePage(page, async (activePage) => {
                await activePage.goto(payload, { waitUntil: 'domcontentloaded', timeout: 30000 });
              });
              log.push({ index: i + 1, type: 'navigate', status: 'ok', detail: payload });
              break;
            }
            case 'play': {
              // payload: recording name, optionally "name with {json params}"
              const withMatch = payload.match(/^(.*?)\s+with\s+(\{[\s\S]*\})$/i);
              const recName = (withMatch ? withMatch[1] : payload).trim();
              let playParams: Record<string, string> = { ...params };
              if (withMatch) {
                try { playParams = { ...playParams, ...JSON.parse(resolveExpressions(withMatch[2], ctx).resolved) }; } catch { /* keep base params */ }
              }
              const recording = await RecordingManager.getInstance().getRecording(recName);
              if (!recording) {
                log.push({ index: i + 1, type: 'play', status: 'failed', detail: `Recording not found: "${recName}"` });
                return report(false, [`Recording not found: "${recName}"`], i);
              }
              const result = await withActivePage(page, async (activePage) => {
                const engine = new ReplayEngine(activePage);
                return engine.play(recording, {
                  context: { params: playParams, variables: ctx.variables },
                  onApprovalNeeded: async (s, reason) => {
                    try {
                      const tabId = await getCurrentTabId(activePage) ?? 0;
                      return await requestApproval(tabId, 'play_automation', s.description ?? s.type, reason);
                    } catch { return false; }
                  },
                });
              });
              if (!result.success) {
                const err = result.results.find(r => r.status !== 'ok')?.error ?? 'Replay failed';
                log.push({ index: i + 1, type: 'play', status: 'failed', detail: `${recName}: ${err}` });
                return report(false, [err], i);
              }
              log.push({ index: i + 1, type: 'play', status: 'ok', detail: `${recName} (${result.stepsExecuted} steps)` });
              break;
            }
            case 'extract': {
              if (!llmProvider) {
                log.push({ index: i + 1, type: 'extract', status: 'failed', detail: 'LLM provider not available' });
                return report(false, ['LLM provider not available for extract step'], i);
              }
              // payload may be a JSON schema or a {schema,...} input object
              let extractInput = payload;
              try {
                const p = JSON.parse(payload);
                if (!p.schema) extractInput = JSON.stringify({ schema: p });
              } catch {
                return report(false, [`Invalid extract payload (must be JSON): ${payload.slice(0, 120)}`], i);
              }
              const raw = await extractWithSchema(page, llmProvider).func(extractInput);
              if (raw.startsWith('Error')) {
                log.push({ index: i + 1, type: 'extract', status: 'failed', detail: raw.slice(0, 200) });
                return report(false, [raw.slice(0, 300)], i);
              }
              const varName = step.saveAs ?? `extract_${i + 1}`;
              try { ctx.variables[varName] = JSON.parse(raw); } catch { ctx.variables[varName] = raw; }
              log.push({ index: i + 1, type: 'extract', status: 'ok', detail: `→ {{${varName}}}` });
              break;
            }
            case 'paginate': {
              if (!llmProvider) {
                return report(false, ['LLM provider not available for paginate step'], i);
              }
              const raw = await paginateAndCollect(page, llmProvider).func(payload);
              if (raw.startsWith('Error')) {
                log.push({ index: i + 1, type: 'paginate', status: 'failed', detail: raw.slice(0, 200) });
                return report(false, [raw.slice(0, 300)], i);
              }
              const varName = step.saveAs ?? `paginate_${i + 1}`;
              try { ctx.variables[varName] = JSON.parse(raw); } catch { ctx.variables[varName] = raw; }
              log.push({ index: i + 1, type: 'paginate', status: 'ok', detail: `→ {{${varName}}}` });
              break;
            }
            case 'fill': {
              const raw = await fillFormFromData(page).func(payload);
              log.push({ index: i + 1, type: 'fill', status: 'ok', detail: raw.slice(0, 200) });
              break;
            }
            case 'compute': {
              if (!llmProvider) {
                return report(false, ['LLM provider not available for compute step'], i);
              }
              const value = await runCompute(llmProvider, step.payload, ctx);
              const varName = step.saveAs ?? `compute_${i + 1}`;
              ctx.variables[varName] = value;
              log.push({ index: i + 1, type: 'compute', status: 'ok', detail: `→ {{${varName}}} = "${value.slice(0, 80)}"` });
              break;
            }
            case 'export': {
              // payload: format (json|csv) optionally with a {{var}} reference
              const format = /csv/i.test(payload) ? 'csv' : 'json';
              const varMatch = step.payload.match(/\{\{\s*([\w-]+)/);
              const data = varMatch ? ctx.variables[varMatch[1]] : ctx.variables;
              exports.push({ format, data });
              log.push({ index: i + 1, type: 'export', status: 'ok', detail: format });
              break;
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.push({ index: i + 1, type: step.type, status: 'failed', detail: msg });
          return report(false, [msg], i);
        }
      }

      return report(true, []);
    },
  };
}
