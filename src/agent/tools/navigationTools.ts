import type { Page } from "playwright-crx";
import { ActionLog } from "../../tracking/actionLog";
import { observePage } from "./pageMapTools";
import { settleAfterAction } from "./stability";
import { ToolFactory, ToolOutput } from "./types";
import { withActivePage, getCurrentTabId } from "./utils";

export function normalizeUrl(raw: string): string {
  const url = (raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!url) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return `https://${url}`;
}

function notifyNavigation(activePage: Page, url: string): void {
  getCurrentTabId(activePage).then(async (tabId) => {
    if (!tabId) return;
    const title = await activePage.title().catch(() => '');
    chrome.runtime.sendMessage({ action: 'tabTitleChanged', tabId, title });
    chrome.runtime.sendMessage({ action: 'targetChanged', tabId, url });
  }).catch(() => undefined);
}

async function withObservation(activePage: Page, detail: string): Promise<ToolOutput> {
  try {
    const obs = await observePage(activePage);
    return { ...obs, text: `${detail}\n${obs.text}` };
  } catch {
    return { text: detail };
  }
}

export const browserNavigate: ToolFactory = (page: Page) =>
  ({
    name: "browser_navigate",
    description:
      "Navigate the browser to a URL and return the observation of the new page.",
    func: async (input: string) => {
      let url = input;
      try {
        const parsed = JSON.parse(input);
        if (parsed && typeof parsed.url === 'string') url = parsed.url;
      } catch { /* plain URL */ }
      url = normalizeUrl(url);
      try {
        return await withActivePage(page, async (activePage) => {
          await activePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          notifyNavigation(activePage, url);
          ActionLog.push({ type: 'navigate', url, description: `navigate to ${url}` });
          const settle = await settleAfterAction(activePage);
          return withObservation(activePage, `Navigated to ${activePage.url()} · ${settle}`);
        });
      } catch (error) {
        return `Error navigating to ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    },
  });

export const browserWaitForNavigation: ToolFactory = (page: Page) =>
  ({
    name: "browser_wait_for_navigation",
    description: 
      "Wait for navigation to complete using specified strategy. Input options (default: all):\n" +
      "  • load - wait for the 'load' event (DOM and resources loaded)\n" +
      "  • domcontentloaded - wait for the 'DOMContentLoaded' event (DOM loaded, faster than 'load')\n" +
      "  • networkidle - wait until network is idle for 500ms (may timeout on sites with continuous activity)\n" +
      "  • all - try multiple strategies in sequence with shorter timeouts (recommended)",
    func: async (strategy: string = "all") => {
      try {
        return await withActivePage(page, async (activePage) => {
          switch (strategy.toLowerCase()) {
            case "load":
              await activePage.waitForLoadState("load", { timeout: 10000 });
              return "Navigation complete (DOM loaded).";
            case "domcontentloaded":
              await activePage.waitForLoadState("domcontentloaded", { timeout: 10000 });
              return "Navigation complete (DOM content loaded).";
            case "networkidle":
              await activePage.waitForLoadState("networkidle", { timeout: 10000 });
              return "Navigation complete (network idle).";
            case "all":
            default:
              // Try multiple strategies in sequence with shorter timeouts
              try {
                await activePage.waitForLoadState("load", { timeout: 5000 });
                try {
                  await activePage.waitForLoadState("networkidle", { timeout: 5000 });
                } catch (networkError) {
                  // Ignore network idle errors
                }
                return "Navigation complete.";
              } catch (loadError) {
                // If load fails, try domcontentloaded
                await activePage.waitForLoadState("domcontentloaded", { timeout: 5000 });
                return "Navigation partially complete (DOM content loaded).";
              }
          }
        });
      } catch (error) {
        return `Error waiting for navigation: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    },
  });

export const browserNavigateBack: ToolFactory = (page: Page) =>
  ({
    name: "browser_navigate_back",
    description: "Go back to the previous page (history.back()). No input.",
    func: async () => {
      try {
        return await withActivePage(page, async (activePage) => {
          await activePage.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
          await settleAfterAction(activePage).catch(() => undefined);
          return withObservation(activePage, `Navigated back to ${activePage.url()}`);
        });
      } catch (err) {
        return `Error going back: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  });

export const browserNavigateForward: ToolFactory = (page: Page) =>
  ({
    name: "browser_navigate_forward",
    description: "Go forward to the next page (history.forward()). No input.",
    func: async () => {
      try {
        return await withActivePage(page, async (activePage) => {
          await activePage.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
          await settleAfterAction(activePage).catch(() => undefined);
          return withObservation(activePage, `Navigated forward to ${activePage.url()}`);
        });
      } catch (err) {
        return `Error going forward: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  });
