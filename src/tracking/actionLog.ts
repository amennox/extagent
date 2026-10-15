import type { CapturedAction } from '../procedures/builder';

/** @deprecated alias kept for older imports */
export type RecordingStep = CapturedAction;

/**
 * ActionLog — records the browser actions the AGENT performs during a task,
 * with resolved locators. After a successful task the operator can save the
 * log as a procedure with one click ("Save as procedure").
 */
class ActionLogImpl {
  private steps: CapturedAction[] = [];
  private enabled = true;

  reset(): void {
    this.steps = [];
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  push(step: CapturedAction): void {
    if (!this.enabled) return;
    // Merge consecutive type steps on the same selector (keep the last value)
    const last = this.steps[this.steps.length - 1];
    if (step.type === 'type' && last?.type === 'type' && last.selector === step.selector) {
      this.steps[this.steps.length - 1] = step;
      return;
    }
    this.steps.push({ ...step, timestamp: step.timestamp ?? Date.now() });
  }

  snapshot(): CapturedAction[] {
    return [...this.steps];
  }

  size(): number {
    return this.steps.length;
  }
}

export const ActionLog = new ActionLogImpl();

