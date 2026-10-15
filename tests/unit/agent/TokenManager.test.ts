import {
  approxTokens, contextTokenCount, observationCharBudget, TokenManager, truncateObservation, DEFAULT_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW,
} from '../../../src/agent/TokenManager';

describe('TokenManager', () => {
  it('estimates tokens as chars/4', () => {
    expect(approxTokens('abcd')).toBe(1);
    expect(approxTokens('abcde')).toBe(2);
    expect(contextTokenCount([{ role: 'user', content: 'abcdefgh' }, { role: 'assistant', content: { a: 1 } }])).toBe(2 + Math.ceil(JSON.stringify({ a: 1 }).length / 4));
  });

  it('keeps single observations small (8k–32k chars) whatever the window', () => {
    expect(observationCharBudget(8_000)).toBe(8_000);
    expect(observationCharBudget(128_000)).toBe(20_480);
    expect(observationCharBudget(1_000_000)).toBe(32_000);
  });

  it('summarizes old turns at 60% of the window', () => {
    expect(new TokenManager(100_000).summarizeThreshold).toBe(60_000);
    expect(new TokenManager().contextWindowSize).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(new TokenManager(1000).contextWindowSize).toBe(MIN_CONTEXT_WINDOW);
  });

  it('truncates observations to a token budget', () => {
    expect(truncateObservation('x'.repeat(100), 10)).toBe('x'.repeat(40) + '[...troncato]');
    expect(truncateObservation('short', 10)).toBe('short');
  });
});
