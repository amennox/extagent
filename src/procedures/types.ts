/**
 * Procedure: the single reusable unit of automation.
 *
 * It replaces three overlapping concepts of the previous versions (recording,
 * skill, replayable memory). A procedure is an ordered list of editable steps
 * with typed parameters and a run history. It can be created by recording the
 * operator, from a successful agent task, by hand, or by import; it runs
 * deterministically (no LLM) except for `ai` steps and failed steps, which are
 * handed to the agent.
 */

export type StepType =
  | 'navigate' | 'click' | 'fill' | 'select' | 'check' | 'press'
  | 'wait' | 'scroll' | 'extract' | 'ai';

export interface StepTarget {
  /** CSS candidates, most robust first */
  candidates: string[];
  /** Accessible label (form fields) */
  label?: string;
  /** Visible text (buttons, links) */
  text?: string;
  /** ARIA role, for role-based fallback */
  role?: string;
  /** URL of the iframe containing the element (absent = main frame) */
  frameUrl?: string;
}

export type ApprovalSetting = 'auto' | 'always' | 'never';

export interface ProcedureStep {
  id: string;
  type: StepType;
  description: string;
  target?: StepTarget;
  /**
   * navigate: URL · fill: text · select: option · check: "true"/"false"
   * press: key · wait: seconds · scroll: up|down|top|bottom
   * May contain {{expressions}}: {{param}}, {{oggi+7g:GG/MM/AAAA}}, {{var.path}}.
   */
  value?: string;
  /** extract: JSON schema of the data */
  schema?: Record<string, unknown>;
  /** extract / ai: variable that receives the output */
  saveAs?: string;
  /** ai step: what the agent must do; extract: optional hint */
  instruction?: string;
  /** Continue when this step fails */
  optional?: boolean;
  approval?: ApprovalSetting;
  /** Page where the step was captured */
  pageUrl?: string;
  /** Small JPEG data URL with the target highlighted */
  thumbnail?: string;
  timestamp?: number;
}

export type ParamType = 'text' | 'number' | 'date' | 'select' | 'secret';

export interface ProcedureParam {
  name: string;
  label?: string;
  type: ParamType;
  required: boolean;
  default?: string;
  options?: string[];
  description?: string;
}

export type RunOutcome = 'success' | 'failure' | 'cancelled' | 'needs_agent';
export type RunMode = 'direct' | 'agent' | 'test';

export interface ProcedureRun {
  at: number;
  outcome: RunOutcome;
  mode: RunMode;
  /** 0-based index of the failed step */
  failedStep?: number;
  error?: string;
  durationMs: number;
  stepsDone: number;
}

export type ProcedureSource = 'recording' | 'agent' | 'manual' | 'import' | 'migration';

export interface Procedure {
  id: string;
  name: string;
  description: string;
  /** Normalized domain where it applies (suggestions in the side panel) */
  domain?: string;
  startUrl?: string;
  params: ProcedureParam[];
  steps: ProcedureStep[];
  /** Free-text operator notes, given to the agent when it has to take over */
  notes?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  source: ProcedureSource;
  runs: ProcedureRun[];
}

export const STEP_TYPES: StepType[] = ['navigate', 'click', 'fill', 'select', 'check', 'press', 'wait', 'scroll', 'extract', 'ai'];

/** Steps that act on a page element */
export const TARGETED_STEPS = new Set<StepType>(['click', 'fill', 'select', 'check', 'press', 'scroll']);

export function newId(prefix = ''): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
