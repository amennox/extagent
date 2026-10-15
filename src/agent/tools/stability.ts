import type { Page } from "playwright-crx";
import { withActivePage } from "./utils";

/**
 * SPA-aware stability wait: resolves when the DOM has been quiet (no
 * mutations) for `quietMs` and the document is ready, or after `timeoutMs`.
 * Eliminates the "read the page before the framework finished rendering"
 * failure class on client-rendered sites.
 */
export async function waitForPageStability(
  page: Page,
  quietMs = 500,
  timeoutMs = 5000
): Promise<string> {
  try {
    return await page.evaluate(
      ({ quietMs, timeoutMs }: { quietMs: number; timeoutMs: number }) => {
        return new Promise<string>((resolve) => {
          const start = Date.now();
          let lastMutation = Date.now();
          let observer: MutationObserver | null = null;
          try {
            observer = new MutationObserver(() => { lastMutation = Date.now(); });
            observer.observe(document.documentElement, {
              childList: true, subtree: true, attributes: true, characterData: true,
            });
          } catch {
            // observation unavailable — fall through to readyState polling
          }
          const timer = setInterval(() => {
            const now = Date.now();
            const quiet = now - lastMutation >= quietMs;
            if (quiet && document.readyState !== 'loading') {
              clearInterval(timer);
              observer?.disconnect();
              resolve(`stable after ${now - start}ms`);
            } else if (now - start >= timeoutMs) {
              clearInterval(timer);
              observer?.disconnect();
              resolve(`still changing after ${timeoutMs}ms (dynamic page, content may keep loading)`);
            }
          }, 100);
        });
      },
      { quietMs, timeoutMs }
    );
  } catch (err) {
    return `stability check unavailable (${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * Post-action settle: short stability wait used automatically after mutating
 * actions (click, fill, press, select). Returns a compact note for tool output.
 */
export async function settleAfterAction(page: Page): Promise<string> {
  const result = await waitForPageStability(page, 400, 4000);
  return result;
}

export function browserWaitForStability(page: Page) {
  return {
    name: "browser_wait_for_stability",
    description:
      "Wait until the page DOM stops changing (SPA rendering settled). Optional input: JSON {quietMs?, timeoutMs?}.",
    func: async (input: string): Promise<string> => {
      let quietMs = 500;
      let timeoutMs = 5000;
      try {
        const parsed = JSON.parse(input || '{}');
        if (typeof parsed.quietMs === 'number') quietMs = parsed.quietMs;
        if (typeof parsed.timeoutMs === 'number') timeoutMs = parsed.timeoutMs;
      } catch { /* defaults */ }
      return withActivePage(page, (activePage) => waitForPageStability(activePage, quietMs, timeoutMs));
    },
  };
}
