import { handleApprovalResponse } from '../agent/approvalManager';
import { TokenTrackingService } from '../tracking/tokenTrackingService';
import { executePrompt, applyTaskFeedback } from './agentController';
import { cancelExecution } from './agentController';
import { clearMessageHistory } from './agentController';
import { initializeAgent } from './agentController';
import { RecordingManager } from './recordingManager';
import { triggerReflection } from './reflectionController';
import { attachToTab, getTabState, getWindowForTab, forceResetPlaywright } from './tabManager';
import { BackgroundMessage } from './types';
import { logWithTimestamp, handleError } from './utils';

/**
 * Handle messages from the UI
 * @param message The message to handle
 * @param sender The sender of the message
 * @param sendResponse The function to send a response
 * @returns True if the message was handled, false otherwise
 */
export function handleMessage(
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
): boolean {
  try {
    // Type guard to check if the message is a valid background message
    if (!isBackgroundMessage(message)) {
      logWithTimestamp(`Ignoring unknown message type: ${JSON.stringify(message)}`, 'warn');
      sendResponse({ success: false, error: 'Unknown message type' });
      return false;
    }

    // Handle the message based on its action
    switch (message.action) {
      case 'executePrompt':
        handleExecutePrompt(message, sendResponse);
        return true; // Keep the message channel open for async response

      case 'cancelExecution':
        handleCancelExecution(message, sendResponse);
        return true;

      case 'clearHistory':
        // Handle async function and keep message channel open
        handleClearHistory(message, sendResponse)
          .catch(error => {
            const errorMessage = handleError(error, 'clearing history');
            logWithTimestamp(`Error in async handleClearHistory: ${errorMessage}`, 'error');
            sendResponse({ success: false, error: errorMessage });
          });
        return true; // Keep the message channel open for async response

      case 'initializeTab':
        // This function uses setTimeout internally to handle async operations
        // We still return true to keep the message channel open
        handleInitializeTab(message, sendResponse);
        return true; // Keep the message channel open for async response
        
      case 'switchToTab':
        handleSwitchToTab(message, sendResponse);
        return true;
        
      case 'getTokenUsage':
        handleGetTokenUsage(message, sendResponse);
        return true;
        
      case 'approvalResponse':
        handleApprovalResponse(message.requestId, message.approved);
        sendResponse({ success: true });
        return true;
        
      case 'reflectAndLearn':
        handleReflectAndLearn(message, sendResponse);
        return true;
        
      case 'tokenUsageUpdated':
        // Just pass through token usage updates
        // This allows the TokenTrackingService to broadcast updates
        // that will be received by all UI components
        sendResponse({ success: true });
        return true;
        
      case 'updateOutput':
        // Just pass through output updates
        // This allows components to send UI updates
        sendResponse({ success: true });
        return true;
        
      case 'providerConfigChanged':
        // Just pass through provider configuration change notifications
        // This allows the ProviderSelector component to refresh
        sendResponse({ success: true });
        return true;
        
      case 'forceResetPlaywright':
        // Handle async function and keep message channel open
        handleForceResetPlaywright(message, sendResponse)
          .catch(error => {
            const errorMessage = handleError(error, 'force resetting Playwright');
            logWithTimestamp(`Error in async handleForceResetPlaywright: ${errorMessage}`, 'error');
            sendResponse({ success: false, error: errorMessage });
          });
        return true; // Keep the message channel open for async response
        
      case 'requestApproval':
        // Just acknowledge receipt of the request approval message
        // The actual approval handling is done by the UI
        sendResponse({ success: true });
        return true;
        
      case 'checkAgentStatus':
        // Handle async function and keep message channel open
        handleCheckAgentStatus(message, sendResponse)
          .catch(error => {
            const errorMessage = handleError(error, 'checking agent status');
            logWithTimestamp(`Error in async handleCheckAgentStatus: ${errorMessage}`, 'error');
            sendResponse({ success: false, error: errorMessage });
          });
        return true; // Keep the message channel open for async response

      case 'startRecordingCapture':
        handleStartRecordingCapture(message, sendResponse)
          .catch(error => {
            sendResponse({ success: false, error: handleError(error, 'starting recording') });
          });
        return true;

      case 'stopRecordingCapture':
        handleStopRecordingCapture(message, sendResponse);
        return true;

      case 'saveRecording':
        handleSaveRecording(message, sendResponse)
          .catch(error => {
            sendResponse({ success: false, error: handleError(error, 'saving recording') });
          });
        return true;

      case 'cancelRecording':
        handleCancelRecording(message, sendResponse)
          .catch(error => {
            sendResponse({ success: false, error: handleError(error, 'cancelling recording') });
          });
        return true;

      case 'deleteRecording':
        handleDeleteRecording(message, sendResponse)
          .catch(error => {
            sendResponse({ success: false, error: handleError(error, 'deleting recording') });
          });
        return true;

      case 'recordingStep':
        handleRecordingStep(message, sendResponse)
          .catch(error => {
            sendResponse({ success: false, error: handleError(error, 'adding recording step') });
          });
        return true;

      case 'playRecording':
        sendResponse({ success: true });
        return true;

      case 'executeSkillPrompt':
        // Re-broadcast so the sidepanel can pick it up and call handleSubmit
        chrome.runtime.sendMessage({ action: 'executeSkillPrompt', skillTitle: message.skillTitle });
        sendResponse({ success: true });
        return true;

      case 'taskFeedback':
        (async () => {
          try {
            const windowId = message.windowId
              ?? (message.tabId ? (await chrome.tabs.get(message.tabId))?.windowId : undefined);
            if (windowId !== undefined) {
              const result = await applyTaskFeedback(windowId, message.positive === true);
              sendResponse({ success: true, ...result });
            } else {
              sendResponse({ success: false, error: 'No window for feedback' });
            }
          } catch (error) {
            sendResponse({ success: false, error: handleError(error, 'applying task feedback') });
          }
        })();
        return true;

      default:
        // This should never happen due to the type guard, but TypeScript requires it
        logWithTimestamp(`Unhandled message action: ${(message as any).action}`, 'warn');
        sendResponse({ success: false, error: 'Unhandled message action' });
        return false;
    }
  } catch (error) {
    const errorMessage = handleError(error, 'handling message');
    logWithTimestamp(`Error handling message: ${errorMessage}`, 'error');
    sendResponse({ success: false, error: errorMessage });
    return false;
  }
}

/**
 * Type guard to check if a message is a valid background message
 * @param message The message to check
 * @returns True if the message is a valid background message, false otherwise
 */
function isBackgroundMessage(message: any): message is BackgroundMessage {
  return (
    message &&
    typeof message === 'object' &&
    'action' in message &&
    (
      message.action === 'executePrompt' ||
      message.action === 'cancelExecution' ||
      message.action === 'clearHistory' ||
      message.action === 'initializeTab' ||
      message.action === 'switchToTab' ||
      message.action === 'getTokenUsage' ||
      message.action === 'approvalResponse' ||
      message.action === 'reflectAndLearn' ||
      message.action === 'tokenUsageUpdated' ||  // Add support for token usage updates
      message.action === 'updateOutput' ||  // Add support for output updates
      message.action === 'providerConfigChanged' ||  // Add support for provider config changes
      message.action === 'tabStatusChanged' ||
      message.action === 'targetCreated' ||
      message.action === 'targetDestroyed' ||
      message.action === 'targetChanged' ||
      message.action === 'tabTitleChanged' ||
      message.action === 'pageDialog' ||
      message.action === 'pageConsole' ||
      message.action === 'pageError' ||
      message.action === 'forceResetPlaywright' ||
      message.action === 'requestApproval' ||
      message.action === 'checkAgentStatus' ||
      message.action === 'startRecordingCapture' ||
      message.action === 'stopRecordingCapture' ||
      message.action === 'saveRecording' ||
      message.action === 'cancelRecording' ||
      message.action === 'deleteRecording' ||
      message.action === 'recordingStep' ||
      message.action === 'playRecording' ||
      message.action === 'executeSkillPrompt' ||
      message.action === 'taskFeedback'
    )
  );
}

/**
 * Handle the executePrompt message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
function handleExecutePrompt(
  message: Extract<BackgroundMessage, { action: 'executePrompt' }>,
  sendResponse: (response?: any) => void
): void {
  // Use the tabId from the message if available
  if (message.tabId) {
    executePrompt(message.prompt, message.tabId);
  } else {
    executePrompt(message.prompt);
  }
  sendResponse({ success: true });
}

/**
 * Handle the cancelExecution message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
function handleCancelExecution(
  message: Extract<BackgroundMessage, { action: 'cancelExecution' }>,
  sendResponse: (response?: any) => void
): void {
  cancelExecution(message.tabId);
  sendResponse({ success: true });
}

/**
 * Handle the clearHistory message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
async function handleClearHistory(
  message: Extract<BackgroundMessage, { action: 'clearHistory' }>,
  sendResponse: (response?: any) => void
): Promise<void> {
  await clearMessageHistory(message.tabId, message.windowId);
  
  // Reset token tracking
  try {
    const tokenTracker = TokenTrackingService.getInstance();
    tokenTracker.reset(message.windowId);
    
    // Notify UI of reset
    chrome.runtime.sendMessage({
      action: 'tokenUsageUpdated',
      content: tokenTracker.getUsage(),
      tabId: message.tabId,
      windowId: message.windowId
    });
  } catch (error) {
    logWithTimestamp(`Error resetting token tracking: ${String(error)}`, 'warn');
  }
  
  sendResponse({ success: true });
}

/**
 * Handle the initializeTab message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
function handleInitializeTab(
  message: Extract<BackgroundMessage, { action: 'initializeTab' }>,
  sendResponse: (response?: any) => void
): void {
  // Initialize the tab as soon as the side panel is opened
  if (message.tabId) {
    // Use setTimeout to make this asynchronous and return the response immediately
    setTimeout(async () => {
      try {
        // Get the tab title before attaching
        let tabTitle = "Unknown Tab";
        try {
          const tab = await chrome.tabs.get(message.tabId);
          if (tab && tab.title) {
            tabTitle = tab.title;
          }
        } catch (titleError) {
          handleError(titleError, 'getting tab title');
        }
        
        await attachToTab(message.tabId, message.windowId);
        await initializeAgent(message.tabId);
        
        // Get the tab state to check if attachment was successful
        const tabState = getTabState(message.tabId);
        if (tabState) {
          // Send a message back to the side panel with the tab title
          chrome.runtime.sendMessage({
            action: 'updateOutput',
            content: {
              type: 'system',
              content: `Connected to tab: ${tabState.title || tabTitle}`
            },
            tabId: message.tabId,
            windowId: tabState.windowId
          });
        }
        
        logWithTimestamp(`Tab ${message.tabId} in window ${message.windowId || 'unknown'} initialized from side panel`);
      } catch (error) {
        handleError(error, 'initializing tab from side panel');
      }
    }, 0);
  }
  sendResponse({ success: true });
}

/**
 * Handle the switchToTab message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
function handleSwitchToTab(
  message: Extract<BackgroundMessage, { action: 'switchToTab' }>,
  sendResponse: (response?: any) => void
): void {
  if (message.tabId) {
    // Get the window ID for this tab if available
    const windowId = getWindowForTab(message.tabId);
    
    // Focus the window first if we have a window ID
    if (windowId) {
      chrome.windows.update(windowId, { focused: true });
    }
    
    // Then focus the tab
    chrome.tabs.update(message.tabId, { active: true });
    
    logWithTimestamp(`Switched to tab ${message.tabId} in window ${windowId || 'unknown'}`);
  }
  sendResponse({ success: true });
}

/**
 * Handle the getTokenUsage message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
function handleGetTokenUsage(
  message: Extract<BackgroundMessage, { action: 'getTokenUsage' }>,
  sendResponse: (response?: any) => void
): void {
  try {
    const tokenTracker = TokenTrackingService.getInstance();
    const usage = tokenTracker.getUsage();
    
    // Get the window ID if available
    const windowId = message.windowId;
    const tabId = message.tabId;
    
    // Send the usage directly in the response
    sendResponse({ 
      success: true, 
      usage 
    });
    
    // Also broadcast it to all clients
    chrome.runtime.sendMessage({
      action: 'tokenUsageUpdated',
      content: usage,
      tabId,
      windowId
    });
  } catch (error) {
    const errorMessage = handleError(error, 'getting token usage');
    logWithTimestamp(`Error getting token usage: ${errorMessage}`, 'error');
    sendResponse({ success: false, error: errorMessage });
  }
}

/**
 * Handle the reflectAndLearn message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
function handleReflectAndLearn(
  message: Extract<BackgroundMessage, { action: 'reflectAndLearn' }>,
  sendResponse: (response?: any) => void
): void {
  try {
    // Trigger the reflection process
    triggerReflection(message.tabId);
    sendResponse({ success: true });
  } catch (error) {
    const errorMessage = handleError(error, 'triggering reflection');
    logWithTimestamp(`Error triggering reflection: ${errorMessage}`, 'error');
    sendResponse({ success: false, error: errorMessage });
  }
}

/**
 * Handle the forceResetPlaywright message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
async function handleForceResetPlaywright(
  message: Extract<BackgroundMessage, { action: 'forceResetPlaywright' }>,
  sendResponse: (response?: any) => void
): Promise<void> {
  try {
    logWithTimestamp('Force resetting Playwright instance');
    
    // Call the forceResetPlaywright function from tabManager
    const result = await forceResetPlaywright();
    
    // Get the current tab and window ID if possible
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabId = tabs[0]?.id;
    const windowId = tabs[0]?.windowId;
    
    // Notify UI components about the reset
    chrome.runtime.sendMessage({
      action: 'updateOutput',
      content: {
        type: 'system',
        content: `Playwright instance has been force reset. ${result ? 'Success' : 'Failed'}`
      },
      tabId,
      windowId
    });
    
    sendResponse({ success: result });
  } catch (error) {
    const errorMessage = handleError(error, 'force resetting Playwright instance');
    logWithTimestamp(`Error force resetting Playwright instance: ${errorMessage}`, 'error');
    sendResponse({ success: false, error: errorMessage });
  }
}

/**
 * Handle the checkAgentStatus message
 * @param message The message to handle
 * @param sendResponse The function to send a response
 */
async function handleCheckAgentStatus(
  message: Extract<BackgroundMessage, { action: 'checkAgentStatus' }>,
  sendResponse: (response?: any) => void
): Promise<void> {
  try {
    // Get the window ID for this tab
    const windowId = message.windowId || (message.tabId ? getWindowForTab(message.tabId) : null);
    
    if (!windowId) {
      logWithTimestamp(`Cannot check agent status: No window ID found for tab ${message.tabId}`, 'warn');
      sendResponse({ success: false, error: 'No window ID found' });
      return;
    }
    
    // Get the agent status from agentController using dynamic import
    const { getAgentStatus } = await import('./agentController');
    const status = getAgentStatus(windowId);
    
    // Send the status back to the UI
    chrome.runtime.sendMessage({
      action: 'agentStatusUpdate',
      status: status.status,
      timestamp: status.timestamp,
      lastHeartbeat: status.lastHeartbeat,
      tabId: message.tabId,
      windowId
    });
    
    sendResponse({ success: true });
  } catch (error) {
    const errorMessage = handleError(error, 'checking agent status');
    logWithTimestamp(`Error checking agent status: ${errorMessage}`, 'error');
    sendResponse({ success: false, error: errorMessage });
  }
}

// ── Navigation capture during recording ──────────────────────────────────────
// The content script cannot observe navigations; the background listens to
// webNavigation events for the recorded tab and adds `navigate` steps.

let recordedTabId: number | null = null;
let lastRecordedNavUrl: string | null = null;

function onRecordedNavigation(details: { tabId: number; url: string; frameId: number }): void {
  if (recordedTabId === null || details.tabId !== recordedTabId) return;
  if (details.frameId !== 0) return; // main frame only
  if (!/^https?:/.test(details.url)) return;
  if (details.url === lastRecordedNavUrl) return; // dedupe (SPA + committed both firing)
  lastRecordedNavUrl = details.url;

  const manager = RecordingManager.getInstance();
  manager.isRecording().then(active => {
    if (!active) return;
    manager.addStep({
      type: 'navigate',
      url: details.url,
      pageUrl: details.url,
      timestamp: Date.now(),
      description: `navigazione verso ${details.url}`,
    }).then(() => {
      chrome.runtime.sendMessage({ action: 'recordingStepAdded' }).catch?.(() => undefined);
      // Re-arm capture in the (re)loaded page
      if (recordedTabId !== null) {
        setTimeout(() => {
          if (recordedTabId !== null) {
            chrome.tabs.sendMessage(recordedTabId, { action: 'startRecordingCapture' }, () => void chrome.runtime.lastError);
          }
        }, 400);
      }
    }).catch(() => undefined);
  }).catch(() => undefined);
}

function attachNavigationCapture(tabId: number): void {
  recordedTabId = tabId;
  lastRecordedNavUrl = null;
  try {
    chrome.webNavigation.onCommitted.addListener(onRecordedNavigation as any);
    chrome.webNavigation.onHistoryStateUpdated.addListener(onRecordedNavigation as any);
  } catch {
    // webNavigation unavailable — navigations simply won't be recorded
  }
}

function detachNavigationCapture(): void {
  try {
    chrome.webNavigation.onCommitted.removeListener(onRecordedNavigation as any);
    chrome.webNavigation.onHistoryStateUpdated.removeListener(onRecordedNavigation as any);
  } catch {
    // ignore
  }
  recordedTabId = null;
  lastRecordedNavUrl = null;
}

async function handleStartRecordingCapture(
  message: Extract<BackgroundMessage, { action: 'startRecordingCapture' }>,
  sendResponse: (response?: any) => void
): Promise<void> {
  const manager = RecordingManager.getInstance();
  await manager.startRecording(message.name);
  // Tell the active tab's content script to start capturing
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'startRecordingCapture' });
      attachNavigationCapture(tabs[0].id);
      // Record the starting URL as the first step
      if (tabs[0].url && /^https?:/.test(tabs[0].url)) {
        lastRecordedNavUrl = tabs[0].url;
        await manager.addStep({
          type: 'navigate',
          url: tabs[0].url,
          pageUrl: tabs[0].url,
          pageTitle: tabs[0].title,
          timestamp: Date.now(),
          description: `pagina iniziale ${tabs[0].url}`,
        });
      }
    }
  } catch {
    // content script may not be injected yet — ignore
  }
  sendResponse({ success: true });
}

function handleStopRecordingCapture(
  _message: Extract<BackgroundMessage, { action: 'stopRecordingCapture' }>,
  sendResponse: (response?: any) => void
): void {
  const stopTabId = recordedTabId;
  detachNavigationCapture();
  if (stopTabId !== null) {
    chrome.tabs.sendMessage(stopTabId, { action: 'stopRecordingCapture' }, () => void chrome.runtime.lastError);
  } else {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'stopRecordingCapture' });
      }
    });
  }
  sendResponse({ success: true });
}

async function handleSaveRecording(
  message: Extract<BackgroundMessage, { action: 'saveRecording' }>,
  sendResponse: (response?: any) => void
): Promise<void> {
  detachNavigationCapture();
  const manager = RecordingManager.getInstance();
  const recording = await manager.stopRecording(message.description ?? '');
  sendResponse({ success: true, recording });
}

async function handleCancelRecording(
  _message: Extract<BackgroundMessage, { action: 'cancelRecording' }>,
  sendResponse: (response?: any) => void
): Promise<void> {
  detachNavigationCapture();
  const manager = RecordingManager.getInstance();
  await manager.cancelRecording();
  sendResponse({ success: true });
}

async function handleDeleteRecording(
  message: Extract<BackgroundMessage, { action: 'deleteRecording' }>,
  sendResponse: (response?: any) => void
): Promise<void> {
  const manager = RecordingManager.getInstance();
  await manager.deleteRecording(message.name);
  sendResponse({ success: true });
}

async function handleRecordingStep(
  message: Extract<BackgroundMessage, { action: 'recordingStep' }>,
  sendResponse: (response?: any) => void
): Promise<void> {
  const manager = RecordingManager.getInstance();
  const isActive = await manager.isRecording();
  if (isActive) {
    await manager.addStep(message.step as any);
    // Notify sidepanel of new step
    chrome.runtime.sendMessage({ action: 'recordingStepAdded' });
  }
  sendResponse({ success: true });
}

/**
 * Set up message listeners
 */
export function setupMessageListeners(): void {
  chrome.runtime.onMessage.addListener(handleMessage);
}
