interface Message { role: string; content: string | unknown }

export const approxTokens = (text: string) => Math.ceil(text.length / 4);

export const contextTokenCount = (msgs: Message[]) =>
  msgs.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + approxTokens(content);
  }, 0);

export interface TrimResult {
  trimmed: Message[];
  removedSummaryPrompt: string | null;
}

export function truncateObservation(text: string, budgetTokens: number): string {
  const budgetChars = budgetTokens * 4;
  if (text.length <= budgetChars) return text;
  return text.slice(0, budgetChars) + '[...troncato]';
}

export const DEFAULT_CONTEXT_WINDOW = 256_000;
export const MIN_CONTEXT_WINDOW = 64_000;

/**
 * Char budget for a single DOM/page observation, proportional to the
 * context window (~10% of the window, in chars ≈ tokens*4).
 * 64k → ~25k chars, 256k (default) → ~100k chars.
 */
export function observationCharBudget(contextWindowSize: number): number {
  const tokens = Math.max(contextWindowSize, MIN_CONTEXT_WINDOW);
  return Math.floor(tokens * 0.10) * 4;
}

export function trimHistory(
  msgs: Message[],
  maxTokens = Math.floor(DEFAULT_CONTEXT_WINDOW * 0.70)
): TrimResult {
  if (contextTokenCount(msgs) <= maxTokens || msgs.length <= 2) {
    return { trimmed: msgs, removedSummaryPrompt: null };
  }

  const indicesToKeep = new Set<number>();
  if (msgs.length > 0) indicesToKeep.add(0);

  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].role === 'user') indicesToKeep.add(i);
  }

  const keptMessages = Array.from(indicesToKeep).map(i => msgs[i]);
  const keptTokenCount = contextTokenCount(keptMessages);
  let remainingTokens = maxTokens - keptTokenCount;

  const assistantIndices: number[] = [];
  for (let i = msgs.length - 1; i >= 1; i--) {
    if (msgs[i].role === 'assistant' && !indicesToKeep.has(i)) {
      assistantIndices.push(i);
    }
  }

  for (const idx of assistantIndices) {
    const msg = msgs[idx];
    const msgTokens = contextTokenCount([msg]);
    if (msgTokens <= remainingTokens) {
      indicesToKeep.add(idx);
      remainingTokens -= msgTokens;
    }
  }

  const trimmed: Message[] = [];
  const removedParts: string[] = [];

  for (let i = 0; i < msgs.length; i++) {
    if (indicesToKeep.has(i)) {
      trimmed.push(msgs[i]);
    } else {
      const content = typeof msgs[i].content === 'string'
        ? msgs[i].content as string
        : JSON.stringify(msgs[i].content);
      removedParts.push(`[${msgs[i].role}]: ${content}`);
    }
  }

  const removedSummaryPrompt = removedParts.length > 0
    ? `Summarize in max 500 tokens:\n${removedParts.join('\n')}`
    : null;

  return { trimmed, removedSummaryPrompt };
}

export class TokenManager {
  readonly contextWindowSize: number;
  readonly trimThreshold: number;

  constructor(contextWindowSize = DEFAULT_CONTEXT_WINDOW) {
    this.contextWindowSize = contextWindowSize;
    this.trimThreshold = Math.floor(contextWindowSize * 0.70);
  }

  trim(msgs: Message[]): TrimResult {
    return trimHistory(msgs, this.trimThreshold);
  }

  truncate(text: string, budgetTokens: number): string {
    return truncateObservation(text, budgetTokens);
  }
}
