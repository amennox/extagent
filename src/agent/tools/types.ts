import type { Page } from "playwright-crx/test";

/** Rich tool output: text for the model plus an optional image (vision models). */
export interface ToolOutput {
  text: string;
  image?: { data: string; mediaType: string };
}

export type ToolResult = string | ToolOutput;

export interface BrowserTool {
  name: string;
  description: string;
  func: (input: string, context?: ToolExecutionContext) => Promise<ToolResult>;
}

export interface ToolExecutionContext {
  requiresApproval?: boolean;
  approvalReason?: string;
  /** True once the task was stopped or the tool timed out (long tools check it between steps) */
  isCancelled?: () => boolean;
}

export type ToolFactory = (page: Page) => BrowserTool;

export function toolResultText(result: ToolResult): string {
  return typeof result === 'string' ? result : result.text;
}

export function toolResultImage(result: ToolResult): ToolOutput['image'] | undefined {
  return typeof result === 'string' ? undefined : result.image;
}
