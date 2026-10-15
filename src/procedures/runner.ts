import type { Frame, Locator, Page } from 'playwright-crx';
import { approvalReason, ApprovalMode } from '../agent/approvalPolicy';
import { createReplayContext, ReplayContext, resolveExpressions } from '../agent/replay/expressionResolver';
import { waitForPageStability } from '../agent/tools/stability';
import { Procedure, ProcedureStep, TARGETED_STEPS } from './types';

/**
 * Deterministic procedure runner (no LLM on the happy path).
 *
 * Locating an element tries, in order: recorded CSS candidates, ARIA role +
 * accessible name, form label, visible text — inside the recorded iframe when
 * there is one. `ai` steps and failed steps are delegated: in direct mode to an
 * `aiResolver` (the agent on a focused sub-task), in tool mode back to the
 * calling agent with a resumable report.
 */

export type StepStatus = 'running' | 'ok' | 'failed' | 'skipped' | 'agent';

export interface StepEvent {
  index: number;
  total: number;
  step: ProcedureStep;
  status: StepStatus;
  message?: string;
}

export interface AiRequest {
  procedure: Procedure;
  index: number;
  step: ProcedureStep;
  /** Instruction with expressions resolved */
  instruction: string;
  /** Why the agent is needed: undefined for ai steps, error for failed steps */
  failure?: string;
  variables: Record<string, unknown>;
}

export interface RunOptions {
  params?: Record<string, string>;
  /** 0-based first step */
  startAt?: number;
  /** 0-based last step (inclusive) */
  endAt?: number;
  approvalMode?: ApprovalMode;
  onStep?: (ev: StepEvent) => void;
  onApproval?: (step: ProcedureStep, reason: string) => Promise<boolean>;
  /** Direct mode: run the agent for ai/failed steps. Returns true when the step is done. */
  aiResolver?: (req: AiRequest) => Promise<{ ok: boolean; output?: string }>;
  /** Extraction (extract steps) */
  extract?: (schema: Record<string, unknown>, hint?: string) => Promise<string>;
  isCancelled?: () => boolean;
  locatorTimeoutMs?: number;
}

export type RunStatus = 'success' | 'failed' | 'needs_agent' | 'cancelled' | 'rejected';

export interface RunReport {
  status: RunStatus;
  stepsDone: number;
  total: number;
  /** 0-based index where the run stopped */
  stoppedAt?: number;
  error?: string;
  variables: Record<string, unknown>;
  log: string[];
  missingParams?: string[];
}

const VALID_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'switch', 'treeitem', 'gridcell', 'searchbox', 'spinbutton', 'slider',
]);

function roleFor(role?: string): string | undefined {
  if (!role) return undefined;
  if (role === 'select') return 'combobox';
  if (role === 'submit') return 'button';
  return VALID_ROLES.has(role) ? role : undefined;
}

export function missingParams(proc: Procedure, params: Record<string, string>): string[] {
  return proc.params
    .filter(p => p.required && !(params[p.name] ?? p.default ?? '').toString().trim())
    .map(p => p.name);
}

export class ProcedureRunner {
  constructor(private page: Page) {}

  private frameFor(step: ProcedureStep): Page | Frame {
    const url = step.target?.frameUrl;
    if (!url || typeof this.page.frames !== 'function') return this.page;
    const frames = this.page.frames();
    const exact = frames.find(f => f.url() === url);
    if (exact) return exact;
    try {
      const want = new URL(url);
      const similar = frames.find(f => {
        try {
          const u = new URL(f.url());
          return u.origin === want.origin && u.pathname === want.pathname;
        } catch { return false; }
      });
      if (similar) return similar;
    } catch { /* srcdoc/about: frames */ }
    return frames.find(f => f !== this.page.mainFrame()) ?? this.page;
  }

  /** Strategies in priority order, each yielding a locator. */
  private strategies(scope: Page | Frame, step: ProcedureStep): Array<{ how: string; loc: Locator }> {
    const t = step.target;
    const out: Array<{ how: string; loc: Locator }> = [];
    if (!t) return out;
    for (const css of t.candidates ?? []) {
      if (css) out.push({ how: css, loc: scope.locator(css) });
    }
    const role = roleFor(t.role);
    const name = (t.label || t.text || '').trim();
    if (role && name) out.push({ how: `role=${role}[name="${name}"]`, loc: scope.getByRole(role as any, { name, exact: true }) });
    if (t.label && (step.type === 'fill' || step.type === 'select' || step.type === 'check')) {
      out.push({ how: `label="${t.label}"`, loc: scope.getByLabel(t.label, { exact: true }) });
    }
    if (t.text && (step.type === 'click' || step.type === 'press')) {
      out.push({ how: `text="${t.text.slice(0, 60)}"`, loc: scope.getByText(t.text.slice(0, 80), { exact: false }) });
    }
    return out;
  }

  /** Find the first strategy matching a visible element; polls until timeout. */
  async locate(step: ProcedureStep, timeoutMs: number): Promise<{ loc: Locator; how: string } | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const scope = this.frameFor(step);
      for (const s of this.strategies(scope, step)) {
        try {
          const count = await s.loc.count();
          for (let i = 0; i < Math.min(count, 5); i++) {
            const candidate = s.loc.nth(i);
            if (await candidate.isVisible()) return { loc: candidate, how: s.how };
          }
        } catch { /* invalid selector for this engine — next */ }
      }
      if (Date.now() >= deadline) return null;
      await new Promise(r => setTimeout(r, 400));
    }
  }

  async run(proc: Procedure, opts: RunOptions = {}): Promise<RunReport> {
    const params: Record<string, string> = {};
    for (const p of proc.params) {
      const v = opts.params?.[p.name] ?? p.default;
      if (v !== undefined) params[p.name] = String(v);
    }
    for (const [k, v] of Object.entries(opts.params ?? {})) params[k] = String(v);
    const ctx: ReplayContext = createReplayContext(params);
    const log: string[] = [];
    const total = proc.steps.length;
    const start = Math.max(0, opts.startAt ?? 0);
    const end = Math.min(total - 1, opts.endAt ?? total - 1);
    const timeout = opts.locatorTimeoutMs ?? 8000;

    const missing = missingParams(proc, params);
    if (missing.length) {
      return { status: 'failed', stepsDone: 0, total, stoppedAt: start, error: `Missing required parameters: ${missing.join(', ')}`, variables: {}, log, missingParams: missing };
    }

    let done = 0;
    for (let i = start; i <= end; i++) {
      const step = proc.steps[i];
      const emit = (status: StepStatus, message?: string) => opts.onStep?.({ index: i, total, step, status, message });
      if (opts.isCancelled?.()) {
        return { status: 'cancelled', stepsDone: done, total, stoppedAt: i, variables: ctx.variables, log };
      }
      emit('running');

      const value = step.value !== undefined ? resolveExpressions(step.value, ctx).resolved : undefined;
      const instruction = step.instruction ? resolveExpressions(step.instruction, ctx).resolved : '';

      // Approval
      const reason = this.approvalFor(step, opts.approvalMode ?? 'risky');
      if (reason) {
        const ok = opts.onApproval ? await opts.onApproval(step, reason).catch(() => false) : true;
        if (!ok) {
          emit('failed', 'rejected');
          log.push(`${i + 1}. ✗ ${step.description} — rejected by the user`);
          return { status: 'rejected', stepsDone: done, total, stoppedAt: i, error: 'Step rejected by the user', variables: ctx.variables, log };
        }
      }

      // AI step
      if (step.type === 'ai') {
        if (!opts.aiResolver) {
          emit('agent', instruction);
          log.push(`${i + 1}. → agent: ${instruction}`);
          return { status: 'needs_agent', stepsDone: done, total, stoppedAt: i, variables: ctx.variables, log };
        }
        emit('agent', instruction);
        const res = await opts.aiResolver({ procedure: proc, index: i, step, instruction, variables: ctx.variables });
        if (!res.ok) {
          emit('failed', 'agent did not complete the step');
          log.push(`${i + 1}. ✗ ${step.description} — agent did not complete it`);
          return { status: 'failed', stepsDone: done, total, stoppedAt: i, error: 'The agent could not complete the AI step', variables: ctx.variables, log };
        }
        if (step.saveAs && res.output !== undefined) ctx.variables[step.saveAs] = res.output;
        emit('ok');
        log.push(`${i + 1}. ✓ ${step.description} (agent)`);
        done++;
        continue;
      }

      try {
        const detail = await this.executeStep(step, value, instruction, ctx, opts, timeout);
        emit('ok', detail);
        log.push(`${i + 1}. ✓ ${step.description}${detail ? ` (${detail})` : ''}`);
        done++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (step.optional) {
          emit('skipped', message);
          log.push(`${i + 1}. – ${step.description} (optional, skipped: ${message})`);
          continue;
        }
        if (opts.aiResolver) {
          emit('agent', message);
          const res = await opts.aiResolver({
            procedure: proc, index: i, step, failure: message, variables: ctx.variables,
            instruction: instruction || `${step.description}${value ? ` (valore: ${value})` : ''}`,
          });
          if (res.ok) {
            emit('ok', 'completed by the agent');
            log.push(`${i + 1}. ✓ ${step.description} (completed by the agent after: ${message})`);
            done++;
            continue;
          }
        }
        emit('failed', message);
        log.push(`${i + 1}. ✗ ${step.description} — ${message}`);
        return {
          status: opts.aiResolver ? 'failed' : 'needs_agent',
          stepsDone: done, total, stoppedAt: i, error: message, variables: ctx.variables, log,
        };
      }
    }
    return { status: 'success', stepsDone: done, total, variables: ctx.variables, log };
  }

  private approvalFor(step: ProcedureStep, mode: ApprovalMode): string | null {
    if (step.approval === 'never') return null;
    if (step.approval === 'always') return `Confirmation required: ${step.description}`;
    if (step.type !== 'click' && step.type !== 'press') return null;
    const label = step.target?.label || step.target?.text || '';
    const tool = step.type === 'click' ? 'browser_click' : 'browser_press_key';
    return approvalReason(tool, { input: label, key: step.value }, {
      mode,
      entry: { ref: 0, role: step.target?.role ?? '', label, candidates: step.target?.candidates ?? [] },
    });
  }

  private async executeStep(
    step: ProcedureStep,
    value: string | undefined,
    instruction: string,
    ctx: ReplayContext,
    opts: RunOptions,
    timeout: number
  ): Promise<string | undefined> {
    const page = this.page;
    let detail: string | undefined;

    if (step.type === 'navigate') {
      if (!value) throw new Error('Navigate step without URL');
      await page.goto(value, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else if (step.type === 'wait') {
      const seconds = Number(value);
      if (seconds > 0) await page.waitForTimeout(Math.min(seconds, 60) * 1000);
      else await waitForPageStability(page, 600, 10000);
    } else if (step.type === 'extract') {
      if (!opts.extract) throw new Error('Extraction not available');
      if (!step.schema) throw new Error('Extract step without schema');
      const raw = await opts.extract(step.schema, instruction || undefined);
      if (/^Error/.test(raw)) throw new Error(raw.slice(0, 300));
      const name = step.saveAs || `extract_${step.id}`;
      try { ctx.variables[name] = JSON.parse(raw); } catch { ctx.variables[name] = raw; }
      detail = `→ {{${name}}}`;
    } else if (step.type === 'scroll' && !step.target?.candidates?.length) {
      await page.evaluate((dir: string) => {
        const se = (document.scrollingElement ?? document.documentElement) as HTMLElement;
        if (dir === 'top') se.scrollTop = 0;
        else if (dir === 'bottom') se.scrollTop = se.scrollHeight;
        else se.scrollTop += (dir === 'up' ? -1 : 1) * Math.round(window.innerHeight * 0.8);
      }, value || 'down');
    } else if (TARGETED_STEPS.has(step.type)) {
      await waitForPageStability(page, 300, 3000).catch(() => undefined);
      const found = await this.locate(step, timeout);
      if (!found) {
        const tried = [...(step.target?.candidates ?? []), step.target?.label, step.target?.text].filter(Boolean).join(' | ');
        throw new Error(`Element not found: ${step.target?.label || step.target?.text || '?'} (tried: ${tried.slice(0, 300)})`);
      }
      detail = found.how.length > 80 ? undefined : found.how;
      const { loc } = found;
      switch (step.type) {
        case 'click':
          try {
            await loc.click({ timeout: 5000 });
          } catch {
            await loc.click({ timeout: 3000, force: true });
          }
          break;
        case 'fill':
          await loc.fill(value ?? '', { timeout: 5000 });
          break;
        case 'select': {
          const option = value ?? '';
          const isNative = await loc.evaluate((el: Element) => el.tagName === 'SELECT').catch(() => false);
          if (isNative) {
            try {
              await loc.selectOption({ label: option }, { timeout: 4000 });
            } catch {
              await loc.selectOption(option, { timeout: 4000 });
            }
          } else {
            await loc.click({ timeout: 4000 });
            const scope = this.frameFor(step);
            try {
              await scope.getByRole('option', { name: option }).first().click({ timeout: 3000 });
            } catch {
              await scope.getByText(option, { exact: false }).last().click({ timeout: 3000 });
            }
          }
          break;
        }
        case 'check':
          if (value === 'false') await loc.uncheck({ timeout: 4000 });
          else await loc.check({ timeout: 4000 });
          break;
        case 'press':
          await loc.press(value || 'Enter', { timeout: 4000 });
          break;
        case 'scroll':
          await loc.scrollIntoViewIfNeeded({ timeout: 4000 });
          break;
      }
    }

    if (step.type !== 'wait' && step.type !== 'extract') {
      await waitForPageStability(page, 400, 4000).catch(() => undefined);
    }
    return detail;
  }
}

/** Text report for the agent (tool mode). */
export function formatRunReport(proc: Procedure, report: RunReport): string {
  const head = `Procedure "${proc.name}"`;
  const vars = Object.keys(report.variables).length
    ? `\nVariables: ${JSON.stringify(report.variables).slice(0, 4000)}`
    : '';
  const logText = report.log.length ? `\nLog:\n${report.log.join('\n')}` : '';
  switch (report.status) {
    case 'success':
      return `${head} completed (${report.stepsDone}/${report.total} steps).${vars}${logText}`;
    case 'needs_agent': {
      const i = report.stoppedAt ?? 0;
      const step = proc.steps[i];
      const remaining = proc.steps.slice(i + 1).map((s, k) => `${i + k + 2}. ${s.description}`).join('\n');
      const why = step?.type === 'ai'
        ? `This step must be done by you: ${step.instruction ?? step.description}`
        : `It failed: ${report.error}`;
      return [
        `${head} stopped at step ${i + 1}/${report.total}: "${step?.description}". ${why}`,
        proc.notes ? `Operator notes: ${proc.notes}` : '',
        `Complete step ${i + 1} yourself with the browser tools, then call run_procedure with {"name": ${JSON.stringify(proc.name)}, "params": <same params>, "startAt": ${i + 2}}.`,
        remaining ? `Remaining steps:\n${remaining}` : 'It was the last step.',
        vars, logText,
      ].filter(Boolean).join('\n');
    }
    case 'rejected':
      return `${head} stopped: the user rejected step ${(report.stoppedAt ?? 0) + 1}. Ask the user how to proceed.${logText}`;
    case 'cancelled':
      return `${head} stopped: cancelled.${logText}`;
    default:
      return `Error: ${head} failed${report.stoppedAt !== undefined ? ` at step ${report.stoppedAt + 1}` : ''}: ${report.error}${logText}`;
  }
}
