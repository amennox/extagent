import { getWindowForTab } from '../background/tabManager';

const SUBMIT_PATTERNS = [
  /\bsubmit\b/i, /\bsend\b/i, /\bconfirm\b/i, /\bsave\b/i,
  /\binvia\b/i, /\bconferma\b/i, /\bsalva\b/i, /\bpubblica\b/i,
  /\bregistra\b/i, /\baggiungi\b/i,
];

const DELETE_PATTERNS = [
  /\belimina\b/i, /\bcancella\b/i, /\brimuovi\b/i, /\bdelete\b/i,
  /\bremove\b/i, /\bcancel\b/i,
];

/**
 * Heuristic check: should this tool call require explicit user approval?
 * Used as a secondary safeguard in addition to the LLM's own requires_approval flag.
 */
export function requiresApproval(toolName: string, toolInput: string): boolean {
  // fill_form_submit always requires approval; fill_form_from_data (field fill only) does not
  if (toolName === 'fill_form_submit') return true;
  if (toolName === 'fill_form_from_data') return false;

  // For click actions, check input text against submit/delete patterns
  if (toolName === 'browser_click') {
    if (SUBMIT_PATTERNS.some(p => p.test(toolInput))) return true;
    if (DELETE_PATTERNS.some(p => p.test(toolInput))) return true;
  }

  return false;
}

export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

// Pending approvals map
const pendingApprovals = new Map<string, {
  resolve: (approved: boolean) => void,
  toolName: string,
  toolInput: string,
  reason: string
}>();

/**
 * Requests approval from the user for a tool execution
 * @param tabId The tab ID to request approval for
 * @param toolName The name of the tool being executed
 * @param toolInput The input to the tool
 * @param reason The reason approval is required
 * @param windowId Optional window ID to scope the approval request to a specific window
 * @returns A promise that resolves to true if approved, false if rejected
 */
export async function requestApproval(
  tabId: number,
  toolName: string,
  toolInput: string,
  reason: string,
  windowId?: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = generateUniqueId();
    // Nobody answering (side panel closed) must not freeze the agent forever:
    // an unanswered request counts as rejected.
    const timer = setTimeout(() => {
      if (pendingApprovals.has(requestId)) {
        pendingApprovals.delete(requestId);
        resolve(false);
      }
    }, APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(requestId, { resolve: (v: boolean) => { clearTimeout(timer); resolve(v); }, toolName, toolInput, reason });
    
    // Get the window ID if not provided
    if (!windowId) {
      try {
        // Try to get the window ID from the tab manager
        windowId = getWindowForTab(tabId);
      } catch (error) {
        console.error('Error getting window ID for tab:', error);
      }
    }
    
    // Send approval request to UI with a callback to handle errors
    chrome.runtime.sendMessage({
      action: 'requestApproval',
      tabId,
      windowId, // the side panel of this window shows it even if the agent moved to another tab
      requestId,
      toolName,
      toolInput,
      reason
    }, (response) => {
      // Handle any potential errors
      if (chrome.runtime.lastError) {
        console.error('Error sending approval request:', chrome.runtime.lastError);
        // If there's an error, resolve with false (reject the action)
        resolve(false);
      }
      // Don't resolve here - wait for the handleApprovalResponse call
    });
  });
}

/** Reject every pending approval (Stop button): the agent must not stay blocked. */
export function cancelPendingApprovals(): number {
  const n = pendingApprovals.size;
  for (const [id, pending] of [...pendingApprovals]) {
    pendingApprovals.delete(id);
    pending.resolve(false);
  }
  return n;
}

/**
 * Handles an approval response from the UI
 * @param requestId The ID of the approval request
 * @param approved Whether the request was approved
 */
export function handleApprovalResponse(requestId: string, approved: boolean): void {
  const pendingApproval = pendingApprovals.get(requestId);
  if (pendingApproval) {
    pendingApproval.resolve(approved);
    pendingApprovals.delete(requestId);
  } else {
    console.warn(`No pending approval found for requestId: ${requestId}`);
  }
}

/**
 * Generates a unique ID for approval requests
 * @returns A unique ID string
 */
function generateUniqueId(): string {
  return `approval_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}
