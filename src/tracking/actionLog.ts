import { RecordingStep } from '../background/recordingManager';

/**
 * ActionLog — records the browser actions the AGENT performs during a task,
 * in replayable RecordingStep form (resolved selectors included).
 *
 * On a successful task the log can be persisted as an auto-generated
 * recording and linked to the reflected memory, making the memory directly
 * replayable via the deterministic ReplayEngine (zero LLM on reuse).
 */
class ActionLogImpl {
  private steps: RecordingStep[] = [];
  private enabled = true;

  reset(): void {
    this.steps = [];
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  push(step: RecordingStep): void {
    if (!this.enabled) return;
    // Merge consecutive type steps on the same selector (keep the last value)
    const last = this.steps[this.steps.length - 1];
    if (step.type === 'type' && last?.type === 'type' && last.selector === step.selector) {
      this.steps[this.steps.length - 1] = step;
      return;
    }
    this.steps.push({ ...step, timestamp: step.timestamp ?? Date.now() });
  }

  snapshot(): RecordingStep[] {
    return [...this.steps];
  }

  size(): number {
    return this.steps.length;
  }
}

export const ActionLog = new ActionLogImpl();

/**
 * Name handoff between the outcome handler (which saves the auto recording)
 * and the reflection controller (which links it to the new memory).
 */
let pendingRecordingName: string | null = null;

export function setPendingRecordingName(name: string | null): void {
  pendingRecordingName = name;
}

export function consumePendingRecordingName(): string | null {
  const n = pendingRecordingName;
  pendingRecordingName = null;
  return n;
}
