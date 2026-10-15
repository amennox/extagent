interface Message { role: string; content: string | unknown }

export const approxTokens = (text: string) => Math.ceil(text.length / 4);

export const contextTokenCount = (msgs: Message[]) =>
  msgs.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + approxTokens(content);
  }, 0);

export function truncateObservation(text: string, budgetTokens: number): string {
  const budgetChars = budgetTokens * 4;
  if (text.length <= budgetChars) return text;
  return text.slice(0, budgetChars) + '[...troncato]';
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const MIN_CONTEXT_WINDOW = 16_000;

/**
 * Char budget for a single observation: ~4% of the context window, between
 * 8k and 32k chars (≈2k–8k tokens). Small observations are what keep long
 * tasks inside the window; older ones are compacted anyway.
 */
export function observationCharBudget(contextWindowSize: number): number {
  const tokens = Math.max(contextWindowSize, MIN_CONTEXT_WINDOW);
  return Math.min(32_000, Math.max(8_000, Math.floor(tokens * 0.04) * 4));
}

export class TokenManager {
  readonly contextWindowSize: number;
  /** Rendered context above this many tokens triggers summarization of old turns */
  readonly summarizeThreshold: number;

  constructor(contextWindowSize = DEFAULT_CONTEXT_WINDOW) {
    this.contextWindowSize = Math.max(contextWindowSize, MIN_CONTEXT_WINDOW);
    this.summarizeThreshold = Math.floor(this.contextWindowSize * 0.6);
  }

  truncate(text: string, budgetTokens: number): string {
    return truncateObservation(text, budgetTokens);
  }
}
