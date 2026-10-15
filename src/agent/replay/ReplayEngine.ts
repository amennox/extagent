import type { Page } from 'playwright-crx';
import { Recording, RecordingStep } from '../../background/recordingManager';
import { waitForPageStability } from '../tools/stability';
import { ReplayContext, createReplayContext, resolveExpressions } from './expressionResolver';

/**
 * Deterministic replay engine for recorded automation sequences.
 *
 * - Executes steps directly via playwright (no LLM in the happy path).
 * - Tries the recorded locator bundle in order (self-healing across candidates),
 *   with a text-based fallback when all selectors fail.
 * - Resolves {{…}} expressions in typed text (dates, params, variables from
 *   previous steps).
 * - Risky steps (submit/delete-like clicks) go through an approval callback.
 * - On unrecoverable failure, returns a structured report so the caller (the
 *   agent LLM) can take over from the failed step.
 */

export interface ReplayStepResult {
  index: number;
  type: RecordingStep['type'];
  description: string;
  status: 'ok' | 'failed' | 'rejected' | 'skipped';
  selectorUsed?: string;
  resolvedText?: string;
  error?: string;
}

export interface ReplayResult {
  success: boolean;
  stepsExecuted: number;
  totalSteps: number;
  results: ReplayStepResult[];
  /** Present when replay stopped before the end */
  failedStep?: RecordingStep & { index: number };
  remainingSteps?: RecordingStep[];
}

export interface ReplayOptions {
  context?: ReplayContext;
  /** Timeout per locator candidate (ms) */
  locatorTimeoutMs?: number;
  /** Called before risky steps; return false to stop. Default: allow. */
  onApprovalNeeded?: (step: RecordingStep, reason: string) => Promise<boolean>;
  /** Progress callback */
  onStep?: (result: ReplayStepResult) => void;
}

const RISKY_TEXT = /invia|conferma|salva|acquista|paga|elimina|cancella|rimuovi|submit|send|save|confirm|delete|remove|buy|pay/i;

function isRiskyStep(step: RecordingStep): boolean {
  if (step.type !== 'click' && step.type !== 'press') return false;
  const haystack = `${step.elementText ?? ''} ${step.elementLabel ?? ''} ${step.selector ?? ''}`;
  return RISKY_TEXT.test(haystack) || /type=["']?submit/i.test(step.selector ?? '');
}

export class ReplayEngine {
  constructor(private page: Page) {}

  private async locate(step: RecordingStep, timeoutMs: number): Promise<{ selector: string } | null> {
    const candidates = (step.candidates && step.candidates.length > 0)
      ? step.candidates
      : (step.selector ? [step.selector] : []);

    for (const selector of candidates) {
      try {
        const el = await this.page.waitForSelector(selector, { timeout: timeoutMs, state: 'visible' });
        if (el) return { selector };
      } catch {
        // try next candidate
      }
    }

    // Text-based fallback (clickable elements only)
    if (step.elementText && (step.type === 'click' || step.type === 'press')) {
      try {
        const textSelector = `text=${step.elementText.slice(0, 60)}`;
        const el = await this.page.waitForSelector(textSelector, { timeout: timeoutMs, state: 'visible' });
        if (el) return { selector: textSelector };
      } catch {
        // give up
      }
    }

    return null;
  }

  async play(recording: Recording, options: ReplayOptions = {}): Promise<ReplayResult> {
    const ctx = options.context ?? createReplayContext();
    const locatorTimeoutMs = options.locatorTimeoutMs ?? 5000;
    const results: ReplayStepResult[] = [];

    const fail = (index: number, step: RecordingStep, error: string, status: ReplayStepResult['status'] = 'failed'): ReplayResult => {
      const result: ReplayStepResult = {
        index,
        type: step.type,
        description: step.description ?? step.type,
        status,
        error,
      };
      results.push(result);
      options.onStep?.(result);
      return {
        success: false,
        stepsExecuted: results.filter(r => r.status === 'ok').length,
        totalSteps: recording.steps.length,
        results,
        failedStep: { ...step, index },
        remainingSteps: recording.steps.slice(index + 1),
      };
    };

    for (let i = 0; i < recording.steps.length; i++) {
      const step = recording.steps[i];

      // Resolve dynamic expressions in the step text
      let resolvedText = step.text;
      if (step.text) {
        resolvedText = resolveExpressions(step.text, ctx).resolved;
      }
      let resolvedUrl = step.url;
      if (step.url) {
        resolvedUrl = resolveExpressions(step.url, ctx).resolved;
      }

      // Approval gate for risky steps
      if (isRiskyStep(step)) {
        const reason = `Azione potenzialmente irreversibile: ${step.description ?? step.elementText ?? step.selector}`;
        const approved = options.onApprovalNeeded
          ? await options.onApprovalNeeded(step, reason).catch(() => false)
          : true;
        if (!approved) {
          return fail(i, step, 'Step rejected by user', 'rejected');
        }
      }

      try {
        let selectorUsed: string | undefined;

        switch (step.type) {
          case 'navigate': {
            if (!resolvedUrl) return fail(i, step, 'Navigate step has no URL');
            await this.page.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            break;
          }
          case 'click': {
            const loc = await this.locate(step, locatorTimeoutMs);
            if (!loc) return fail(i, step, `Element not found (tried: ${(step.candidates ?? [step.selector]).join(', ')})`);
            selectorUsed = loc.selector;
            await this.page.click(loc.selector, { timeout: locatorTimeoutMs });
            break;
          }
          case 'type': {
            const loc = await this.locate(step, locatorTimeoutMs);
            if (!loc) return fail(i, step, `Field not found (tried: ${(step.candidates ?? [step.selector]).join(', ')})`);
            selectorUsed = loc.selector;
            await this.page.fill(loc.selector, resolvedText ?? '', { timeout: locatorTimeoutMs });
            break;
          }
          case 'select': {
            const loc = await this.locate(step, locatorTimeoutMs);
            if (!loc) return fail(i, step, `Select not found (tried: ${(step.candidates ?? [step.selector]).join(', ')})`);
            selectorUsed = loc.selector;
            try {
              await this.page.selectOption(loc.selector, { value: resolvedText ?? '' });
            } catch {
              // fallback: select by visible label
              await this.page.selectOption(loc.selector, { label: step.elementText ?? resolvedText ?? '' });
            }
            break;
          }
          case 'check': {
            const loc = await this.locate(step, locatorTimeoutMs);
            if (!loc) return fail(i, step, `Checkbox not found (tried: ${(step.candidates ?? [step.selector]).join(', ')})`);
            selectorUsed = loc.selector;
            const shouldCheck = resolvedText !== 'false';
            if (shouldCheck) await this.page.check(loc.selector, { timeout: locatorTimeoutMs });
            else await this.page.uncheck(loc.selector, { timeout: locatorTimeoutMs });
            break;
          }
          case 'press': {
            const loc = await this.locate(step, locatorTimeoutMs);
            if (!loc) return fail(i, step, `Element not found for key press`);
            selectorUsed = loc.selector;
            await this.page.press(loc.selector, resolvedText || 'Enter', { timeout: locatorTimeoutMs });
            break;
          }
          case 'wait': {
            await this.page.waitForTimeout(1000);
            break;
          }
          default:
            return fail(i, step, `Unknown step type: ${(step as any).type}`);
        }

        // SPA-aware settle after mutating steps, so the next locator lookup
        // sees the rendered page instead of the pre-action one.
        if (step.type !== 'wait') {
          await waitForPageStability(this.page, 400, 4000).catch(() => undefined);
        }

        const result: ReplayStepResult = {
          index: i,
          type: step.type,
          description: step.description ?? step.type,
          status: 'ok',
          selectorUsed,
          resolvedText: resolvedText !== step.text ? resolvedText : undefined,
        };
        results.push(result);
        options.onStep?.(result);
      } catch (err) {
        return fail(i, step, err instanceof Error ? err.message : String(err));
      }
    }

    return {
      success: true,
      stepsExecuted: results.filter(r => r.status === 'ok').length,
      totalSteps: recording.steps.length,
      results,
    };
  }
}
