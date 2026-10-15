import type { Page, Dialog } from "playwright-crx";
import { getCurrentPage } from "../PageContextManager";

/**
 * Helper function to get the current tab ID from a page
 * @param page The page to get the tab ID for
 * @returns Promise resolving to the tab ID or undefined if not found
 */
export async function getCurrentTabId(page: Page): Promise<number | undefined> {
  try {
    // Try to use internal Playwright-CRX APIs to get the tab ID
    if ((page as any)._session && (page as any)._session._connection && (page as any)._session._connection._transport) {
      const transport = (page as any)._session._connection._transport;
      
      // If this is a CrxTransport, it might have a _tabId property
      if (transport._tabId) {
        return transport._tabId;
      }
    }
    
    // If that fails, try to get the tab ID from Chrome
    // This is a fallback method that might not always work
    const pages = page.context().pages();
    const pageIndex = pages.indexOf(page);
    
    if (pageIndex >= 0) {
      // Get all Chrome tabs
      const chromeTabs = await chrome.tabs.query({});
      
      // Try to match by URL
      const pageUrl = page.url();
      const matchingTab = chromeTabs.find(tab => tab.url === pageUrl);
      
      if (matchingTab && matchingTab.id) {
        return matchingTab.id;
      }
    }
  } catch (error) {
    console.error('Error getting current tab ID:', error);
  }
  
  return undefined;
}

// Output size limits.
// MAX_RETURN_CHARS is dynamic: it is derived from the active profile's context
// window (see setMaxReturnChars, wired in ExecutionEngine.setActiveProfile).
// A single observation is capped at ~8k tokens: keeping every observation small
// is what lets long tasks fit in the context without losing the thread.
const DEFAULT_MAX_RETURN_CHARS = 32_000;
const MIN_RETURN_CHARS = 8_000;
export let MAX_RETURN_CHARS = DEFAULT_MAX_RETURN_CHARS;

/** Set the observation char limit (floored at 8k). Pass undefined to restore the default. */
export function setMaxReturnChars(chars?: number): void {
  MAX_RETURN_CHARS = chars === undefined
    ? DEFAULT_MAX_RETURN_CHARS
    : Math.max(MIN_RETURN_CHARS, Math.floor(chars));
}

/**
 * Helper function to execute a function with the active page from PageContextManager
 * @param page The original page reference
 * @param fn The function to execute with the active page
 * @returns The result of the function
 */
export async function withActivePage<T>(
  page: Page, 
  fn: (activePage: Page) => Promise<T>
): Promise<T> {
  // Get the current active page from PageContextManager
  const activePage = getCurrentPage(page);
  
  // Execute the function with the active page
  return await fn(activePage);
}

/**
 * Truncate a string to a maximum length
 * @param str The string to truncate
 * @param maxLength The maximum length (default: MAX_RETURN_CHARS)
 * @returns The truncated string
 */
export function truncate(str: string, maxLength: number = MAX_RETURN_CHARS): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + `\n\n[Truncated ${str.length - maxLength} characters]`;
}

// Dialog handling
export let lastDialog: Dialog | null = null;

export function resetDialog() {
  lastDialog = null;
}

export function installDialogListener(page: Page) {
  // Get the active page
  const activePage = getCurrentPage(page);
  
  // Install the dialog listener on the active page
  activePage.on("dialog", dialog => {
    lastDialog = dialog;
  });
}
