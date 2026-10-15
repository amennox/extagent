import { BrowserAgent, createBrowserAgent, executePromptWithFallback, needsReinitialization } from "../agent/AgentCore";
import { ExecutionCallbacks } from "../agent/ExecutionEngine";
import { setCurrentPage } from "../agent/PageContextManager";
import { contextTokenCount } from "../agent/TokenManager";
import { DomainProfileManager } from "../agent/domainProfileManager";
import { profilePage, profileSummary, playbookFor } from "../agent/pageProfiler";
import { getLang, t } from "../i18n";
import { ActionLog, setPendingRecordingName } from "../tracking/actionLog";
import { MemoryService } from "../tracking/memoryService";
import { ScreenshotManager } from "../tracking/screenshotManager";
import { TokenTrackingService } from "../tracking/tokenTrackingService";
import { ConfigManager } from "./configManager";
import { RecordingManager } from "./recordingManager";
import { saveReflectionMemory, triggerReflection } from "./reflectionController";
import { 
  resetStreamingState, 
  addToStreamingBuffer, 
  getStreamingBuffer, 
  setStreamingBuffer,
  clearStreamingBuffer, 
  finalizeStreamingSegment, 
  startNewSegment, 
  getCurrentSegmentId, 
  incrementSegmentId,
  signalStreamingComplete
} from "./streamingManager";
import { 
  getCurrentTabId, 
  getTabState, 
  setTabState, 
  getWindowForTab, 
  getAgentForWindow, 
  setAgentForWindow,
  getAgentForTab,
  isConnectionHealthy
} from "./tabManager";
import { ProviderType, AgentStatus, AgentStatusInfo } from "./types";
import { sendUIMessage, logWithTimestamp, handleError } from "./utils";

// Generic message format that works with all providers
interface GenericMessage {
  role: string;
  content: string | any;
}

// Interface for structured message history
interface MessageHistory {
  provider: ProviderType;
  originalRequest: GenericMessage | null;
  conversationHistory: GenericMessage[];
}

// Maximum token budget for the cross-task conversation history kept per window.
// Aligned with the default 256k context window: same 70% threshold used by the
// in-task trimming (TokenManager), so the two layers are consistent.
const MAX_CONVERSATION_TOKENS = Math.floor(256000 * 0.70);

// Message histories for conversation context (one per window)
const windowMessageHistories = new Map<number, MessageHistory>();

// Tracks window:domain pairs whose memories were already auto-injected
const injectedMemoryDomains = new Set<string>();

// Last task context per window: domain + memories in play (for outcome-based
// reinforcement and 👍/👎 feedback)
interface LastTaskInfo { domain: string; memoryIds: number[]; }
const lastTaskInfoByWindow = new Map<number, LastTaskInfo>();

async function MemoryManagerIsEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.sync.get({ memoryEnabled: true });
    return result.memoryEnabled !== false;
  } catch {
    return true;
  }
}

/**
 * Apply explicit operator feedback (👍/👎) to the memories used in the last
 * task of this window: 👍 validates them, 👎 removes provisional ones and
 * weakens validated ones.
 */
export async function applyTaskFeedback(windowId: number, positive: boolean): Promise<{ affected: number }> {
  const info = lastTaskInfoByWindow.get(windowId);
  if (!info?.memoryIds?.length) return { affected: 0 };
  const service = MemoryService.getInstance();
  if (positive) {
    await service.reinforceMemories(info.memoryIds, true);
  } else {
    await service.penalizeMemories(info.memoryIds);
  }
  return { affected: info.memoryIds.length };
}

// Map to track agent status by window ID
const agentStatusMap = new Map<number, AgentStatusInfo>();

/**
 * Set the agent status for a window
 * @param windowId The window ID
 * @param status The agent status
 */
export function setAgentStatus(windowId: number, status: AgentStatus): void {
  const current = agentStatusMap.get(windowId);
  const now = Date.now();
  
  agentStatusMap.set(windowId, { 
    status, 
    timestamp: now,
    lastHeartbeat: now
  });
  
  // Log state transitions
  if (!current || current.status !== status) {
    logWithTimestamp(`Agent status transition: ${current?.status || 'undefined'} -> ${status} for window ${windowId}`);
  }
}

/**
 * Update the agent heartbeat for a window
 * @param windowId The window ID
 */
export function updateAgentHeartbeat(windowId: number): void {
  const current = agentStatusMap.get(windowId);
  if (current && current.status === AgentStatus.RUNNING) {
    agentStatusMap.set(windowId, {
      ...current,
      lastHeartbeat: Date.now()
    });
  }
}

/**
 * Get the agent status for a window
 * @param windowId The window ID
 * @returns The agent status info
 */
export function getAgentStatus(windowId: number): AgentStatusInfo {
  return agentStatusMap.get(windowId) || { 
    status: AgentStatus.IDLE, 
    timestamp: Date.now(),
    lastHeartbeat: 0
  };
}

/**
 * Get the current provider type from config
 */
async function getCurrentProvider(): Promise<ProviderType> {
  const configManager = ConfigManager.getInstance();
  const config = await configManager.getProviderConfig();
  return config.provider;
}

/**
 * Clear message history for a specific window
 * @param tabId The tab ID to identify the window
 * @param windowId Optional window ID to clear history for
 */
export async function clearMessageHistory(tabId?: number, windowId?: number): Promise<void> {
  // Get the screenshot manager
  const screenshotManager = ScreenshotManager.getInstance();
  
  // Get current provider
  const provider = await getCurrentProvider();
  
  // If windowId is not provided but tabId is, try to get the window ID
  if (tabId && !windowId) {
    windowId = getWindowForTab(tabId);
  }
  
  // If we have a window ID, clear that specific window's history
  if (windowId) {
    // Clear message history for a specific window
    windowMessageHistories.set(windowId, { provider, originalRequest: null, conversationHistory: [] });
    // Clear screenshots
    screenshotManager.clear();
    logWithTimestamp(`Message history and screenshots cleared for window ${windowId}`);
  } else if (getCurrentTabId()) {
    // Try to get the window ID for the current tab
    const currentWindowId = getWindowForTab(getCurrentTabId()!);
    if (currentWindowId) {
      // Clear message history for the current window
      windowMessageHistories.set(currentWindowId, { provider, originalRequest: null, conversationHistory: [] });
      // Clear screenshots
      screenshotManager.clear();
      logWithTimestamp(`Message history and screenshots cleared for current window ${currentWindowId}`);
    }
  } else {
    // Clear all message histories if no window ID is specified
    windowMessageHistories.clear();
    // Clear screenshots
    screenshotManager.clear();
    logWithTimestamp("All message histories and screenshots cleared");
  }
}

/**
 * Get message history for a specific window
 * @param tabId The tab ID to identify the window
 * @returns The combined message history for the window (original request + conversation)
 */
export async function getMessageHistory(tabId: number): Promise<GenericMessage[]> {
  // Get the window ID for this tab
  const windowId = getWindowForTab(tabId);
  if (!windowId) {
    logWithTimestamp(`Cannot get message history: No window ID found for tab ${tabId}`, 'warn');
    return [];
  }
  
  // Get current provider
  const provider = await getCurrentProvider();
  
  if (!windowMessageHistories.has(windowId)) {
    windowMessageHistories.set(windowId, { provider, originalRequest: null, conversationHistory: [] });
  }
  
  const history = windowMessageHistories.get(windowId)!;
  
  // Update provider if it has changed
  if (history.provider !== provider) {
    history.provider = provider;
    windowMessageHistories.set(windowId, history);
  }
  
  // Check if we need to avoid duplication of the first message
  let messagesToConvert: GenericMessage[] = [];
  
  if (history.originalRequest) {
    // Check if the first message in conversationHistory is the same as originalRequest
    const isDuplicate = history.conversationHistory.length > 0 && 
                        history.conversationHistory[0].role === history.originalRequest.role &&
                        history.conversationHistory[0].content === history.originalRequest.content;
    
    if (isDuplicate) {
      // If duplicate, only use conversationHistory
      messagesToConvert = history.conversationHistory;
      logWithTimestamp(`Avoided duplicate first message for tab ${tabId}`);
    } else {
      // If not duplicate, combine originalRequest with conversationHistory
      messagesToConvert = [history.originalRequest, ...history.conversationHistory];
    }
  } else {
    // If no originalRequest, just use conversationHistory
    messagesToConvert = history.conversationHistory;
  }
  
  // Convert generic messages to provider-specific format
  const convertedMessages = convertMessagesToProviderFormat(
    messagesToConvert,
    provider
  );
  
  return convertedMessages;
}

/**
 * Convert generic messages to provider-specific format
 * @param messages The generic messages to convert
 * @param provider The provider to convert to
 * @returns The provider-specific messages
 */
function convertMessagesToProviderFormat(messages: GenericMessage[], _provider: ProviderType): GenericMessage[] {
  return messages.map(msg => ({
    role: msg.role === "assistant" ? "assistant" : "user",
    content: msg.content,
  }));
}

/**
 * Get the structured message history object for a specific window
 * @param tabId The tab ID to identify the window
 * @returns The structured message history object
 */
export async function getStructuredMessageHistory(tabId: number): Promise<MessageHistory> {
  // Get the window ID for this tab
  const windowId = getWindowForTab(tabId);
  if (!windowId) {
    logWithTimestamp(`Cannot get structured message history: No window ID found for tab ${tabId}`, 'warn');
    // Return an empty history if no window ID is found
    const provider = await getCurrentProvider();
    return { provider, originalRequest: null, conversationHistory: [] };
  }
  
  // Get current provider
  const provider = await getCurrentProvider();
  
  if (!windowMessageHistories.has(windowId)) {
    windowMessageHistories.set(windowId, { provider, originalRequest: null, conversationHistory: [] });
  }
  
  const history = windowMessageHistories.get(windowId)!;
  
  // Update provider if it has changed
  if (history.provider !== provider) {
    history.provider = provider;
    windowMessageHistories.set(windowId, history);
  }
  
  return history;
}

/**
 * Set the original request for a specific window
 * @param tabId The tab ID to identify the window
 * @param request The original request message
 */
export async function setOriginalRequest(tabId: number, request: GenericMessage): Promise<void> {
  // Get the window ID for this tab
  const windowId = getWindowForTab(tabId);
  if (!windowId) {
    logWithTimestamp(`Cannot set original request: No window ID found for tab ${tabId}`, 'warn');
    return;
  }
  
  const history = await getStructuredMessageHistory(tabId);
  history.originalRequest = request;
  windowMessageHistories.set(windowId, history);
}

/**
 * Add a message to the conversation history for a specific window
 * @param tabId The tab ID to identify the window
 * @param message The message to add
 */
export async function addToConversationHistory(tabId: number, message: GenericMessage): Promise<void> {
  // Get the window ID for this tab
  const windowId = getWindowForTab(tabId);
  if (!windowId) {
    logWithTimestamp(`Cannot add to conversation history: No window ID found for tab ${tabId}`, 'warn');
    return;
  }
  
  const history = await getStructuredMessageHistory(tabId);
  history.conversationHistory.push(message);
  windowMessageHistories.set(windowId, history);
}

// No replacement - removing the isNewTaskRequest function

/**
 * Initialize the agent if we have a page and API key
 * @param tabId The tab ID to initialize the agent for
 * @param forceReinit Optional flag to force reinitialization
 * @returns Promise resolving to true if initialization was successful, false otherwise
 */
export async function initializeAgent(tabId: number, forceReinit: boolean = false): Promise<boolean> {
  const tabState = getTabState(tabId);
  
  if (!tabState?.page || !tabState.windowId) {
    return false;
  }
  
  const windowId = tabState.windowId;
  
  // Get provider configuration
  const configManager = ConfigManager.getInstance();
  const providerConfig = await configManager.getProviderConfig();
  
  // Update token tracking service with current provider and model
  const tokenTracker = TokenTrackingService.getInstance();
  tokenTracker.updateProviderAndModel(providerConfig.provider, providerConfig.apiModelId || '');
  
  // Check if we need to initialize or reinitialize the agent
  const existingAgent = getAgentForWindow(windowId);
  const needsInit = !existingAgent || forceReinit;
  const needsReinit = existingAgent && await needsReinitialization(existingAgent, providerConfig);
  
  if (needsInit || needsReinit) {
    try {
      if (providerConfig.apiKey) {
        logWithTimestamp(`Creating LLM agent for window ${windowId} with ${providerConfig.provider} provider...`);
        const agent = await createBrowserAgent(tabState.page, providerConfig.apiKey);
        
        // Store the agent by window ID
        setAgentForWindow(windowId, agent);

        // Load domain profile for this tab
        try {
          const pageUrl = await tabState.page.url();
          const profile = await DomainProfileManager.getInstance().matchProfileForUrl(pageUrl);
          await DomainProfileManager.getInstance().setActiveProfileName(profile?.display_name ?? null);
          const promptManager = (agent as any).promptManager;
          if (promptManager && typeof promptManager.setProfileAddendum === 'function') {
            promptManager.setProfileAddendum(profile?.system_prompt_addendum ?? '');
          }
        } catch {
          // page URL not available yet; profile will be loaded on first prompt
        }

        logWithTimestamp(`LLM agent created successfully for window ${windowId}`);
        return true;
      } else {
        logWithTimestamp('No API key found for the selected provider, skipping agent initialization', 'warn');
        return false;
      }
    } catch (agentError) {
      handleError(agentError, 'creating agent');
      return false;
    }
  }
  
  return !!existingAgent;
}

/**
 * Cancel the current execution
 * @param tabId The tab ID to cancel execution for
 */
export function cancelExecution(tabId?: number): void {
  if (!tabId) {
    // If no tab ID provided, try to cancel the current tab's agent
    const currentTabId = getCurrentTabId();
    if (!currentTabId) return;
    tabId = currentTabId;
  }
  
  // Get the window ID for this tab
  const windowId = getWindowForTab(tabId);
  if (!windowId) {
    logWithTimestamp(`Cannot cancel execution for tab ${tabId}: no window ID found`);
    return;
  }
  
  // Get the agent for this window
  const agent = getAgentForWindow(windowId);
  if (!agent) {
    logWithTimestamp(`Cannot cancel execution for window ${windowId}: no agent found`);
    return;
  }
  
  // Cancel the agent
  agent.cancel();
  
  // Notify UI
  sendUIMessage('updateOutput', {
    type: 'system',
    content: 'Cancelling execution...'
  }, tabId);
  
  // Immediately notify UI that processing is complete
  sendUIMessage('processingComplete', null, tabId);
  
  // Set agent status to IDLE
  setAgentStatus(windowId, AgentStatus.IDLE);
  
  logWithTimestamp(`Cancelled execution for tab ${tabId} in window ${windowId}`);
}

/**
 * Execute a prompt using the LLM agent
 * @param prompt The prompt to execute
 * @param tabId Optional tab ID to execute the prompt for
 * @param isReflectionPrompt Optional flag to indicate if this is a reflection prompt
 */
export async function executePrompt(prompt: string, tabId?: number, isReflectionPrompt: boolean = false): Promise<void> {
  try {
    // Get provider configuration from ConfigManager
    const configManager = ConfigManager.getInstance();
    const providerConfig = await configManager.getProviderConfig();
    
    if (!providerConfig.apiKey) {
      const lang = await getLang().catch(() => 'it' as const);
      sendUIMessage('updateOutput', {
        type: 'system',
        content: t('error.apiKeyMissing', lang)
      }, tabId);
      sendUIMessage('processingComplete', null, tabId);
      return;
    }

    // Use the provided tabId if available, otherwise query for the active tab
    let targetTabId = tabId;
    if (!targetTabId) {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      targetTabId = tabs[0]?.id;
    }
    
    if (!targetTabId) {
      sendUIMessage('updateOutput', {
        type: 'system',
        content: 'Error: Could not determine which tab to use.'
      }, tabId);
      sendUIMessage('processingComplete', null, tabId);
      return;
    }
    
    logWithTimestamp(`Executing prompt for tab ${targetTabId}: "${prompt}"`);
    
    // Get the tab state
    const tabState = getTabState(targetTabId);
    
    // Check if we need to initialize or reattach
    const tabWindowId = tabState?.windowId;
    const needsInitialization = !tabState?.page || !tabWindowId || !getAgentForWindow(tabWindowId);
    const connectionBroken = tabState?.page && !(await isConnectionHealthy(tabState.page));
    
    if (needsInitialization || connectionBroken) {
      // If connection is broken, log it
      if (connectionBroken) {
        logWithTimestamp("Connection health check failed, reattaching...", 'warn');
        sendUIMessage('updateOutput', {
          type: 'system',
          content: 'Debug session was closed, reattaching...'
        }, targetTabId);
      } else {
        sendUIMessage('updateOutput', {
          type: 'system',
          content: 'Initializing for tab...'
        }, targetTabId);
      }
      
      // Import the attachToTab function dynamically to avoid circular dependencies
      const { attachToTab } = await import('./tabManager');
      
      // Attach to the tab
      const attachResult = await attachToTab(targetTabId);
      
      // Check if attachResult is an object with error information
      if (attachResult !== true && attachResult !== false && typeof attachResult === 'object' && 'error' in attachResult) {
        // This is a specific error case with detailed information
        if (attachResult.error === 'unsupported_tab') {
          // Handle unsupported tab error with a specific message
          sendUIMessage('updateOutput', {
            type: 'system',
            content: `Error: ${attachResult.reason} Please try using the extension in a regular web page tab.`
          }, targetTabId);
          sendUIMessage('processingComplete', null, targetTabId);
          return;
        }
      } else if (attachResult === true) {
        // Check if we navigated to google.com
        try {
          const tab = await chrome.tabs.get(targetTabId);
          if (tab && tab.url && tab.url.includes('google.com')) {
            // If the URL contains google.com, we might have auto-navigated there
            sendUIMessage('updateOutput', {
              type: 'system',
              content: 'Note: Navigated to Google to enable extension functionality in this tab.'
            }, targetTabId);
          }
        } catch (error) {
          // Ignore errors checking the tab URL
        }
      }
      // If attachResult is a number, it means a new tab was created
      else if (typeof attachResult === 'number') {
        // Update the target tab ID to the new one
        logWithTimestamp(`Tab ${targetTabId} was replaced with new tab ${attachResult}`);
        targetTabId = attachResult;
      }
      
      await initializeAgent(targetTabId);
    }

    // Get the updated tab state
    const updatedTabState = getTabState(targetTabId);
    
    // If we still don't have a page or window ID, something went wrong
    if (!updatedTabState?.page || !updatedTabState?.windowId) {
      sendUIMessage('updateOutput', {
        type: 'system',
        content: 'Error: Failed to initialize Playwright or create agent. This may be because you are using the extension in an unsupported tab type.'
      }, targetTabId);
      sendUIMessage('processingComplete', null, targetTabId);
      return;
    }
    
    // Update PageContextManager with the new page
    try {
      setCurrentPage(updatedTabState.page);
      logWithTimestamp(`Updated PageContextManager with page for tab ${targetTabId} in executePrompt`);
    } catch (error) {
      logWithTimestamp(`Error updating PageContextManager in executePrompt: ${error instanceof Error ? error.message : String(error)}`, 'warn');
    }

    // Add current page context to history if we have a page
    if (updatedTabState.page) {
      try {
        const currentUrl = await updatedTabState.page.url();
        const currentTitle = await updatedTabState.page.title();

        // Profile the page structure (framework, SPA, UI kit, iframes) to pick
        // the right interaction strategy. Fast (~50ms), non-blocking on failure.
        let profileNote = '';
        let playbook = '';
        try {
          const pageProfile = await profilePage(updatedTabState.page);
          if (pageProfile) {
            profileNote = ` · ${profileSummary(pageProfile)}`;
            const lang = await getLang().catch(() => 'it' as const);
            playbook = playbookFor(pageProfile, lang === 'en' ? 'en' : 'it');
          }
        } catch { /* profiling is best-effort */ }

        // Add a more explicit system message about the current page
        const pageContextMessage = `Current page: ${currentUrl} (${currentTitle})${profileNote} - Consider this context when executing commands. If asked to summarize, create tables, or analyze options without specific references, assume the request refers to content on this page.`;

        sendUIMessage('updateOutput', {
          type: 'system',
          content: pageContextMessage
        }, targetTabId);

        // Set the current page context in the PromptManager
        // This will be included in the system prompt
        const updatedWindowId = updatedTabState.windowId;
        const agent = getAgentForWindow(updatedWindowId);
        if (agent) {
          // Access the PromptManager through the agent
          // This is a bit of a hack since we don't have direct access to the PromptManager
          // We're assuming the agent has a property called promptManager
          const promptManager = (agent as any).promptManager;
          if (promptManager && typeof promptManager.setCurrentPageContext === 'function') {
            promptManager.setCurrentPageContext(currentUrl, currentTitle);
          }
          if (playbook && promptManager && typeof promptManager.setPagePlaybook === 'function') {
            promptManager.setPagePlaybook(playbook);
          }
        }
      } catch (error) {
        logWithTimestamp("Could not get current page info: " + String(error), 'warn');
      }
    }
    
    // Execute the prompt
    sendUIMessage('updateOutput', {
      type: 'system',
      content: `Executing prompt: "${prompt}"`
    }, targetTabId);
    
    // Set agent status to RUNNING if we have a window ID
    if (updatedTabState.windowId) {
      setAgentStatus(updatedTabState.windowId, AgentStatus.RUNNING);
    }
    
    // Always enable streaming
    const useStreaming = true;
    
    // Reset streaming buffer and segment ID
    resetStreamingState();
    
    // Get the structured message history
    const history = await getStructuredMessageHistory(targetTabId);
    
    // Check if this is the first prompt (no original request yet)
    if (!history.originalRequest) {
      // Store this as the original request without adding any special tag
      await setOriginalRequest(targetTabId, { 
        role: "user", 
        content: prompt 
      });
      
      // Also add it to the conversation history to maintain the flow
      await addToConversationHistory(targetTabId, { 
        role: "user", 
        content: prompt 
      });
      
      logWithTimestamp(`Set original request for tab ${targetTabId}: "${prompt}"`);
    } else {
      // This is a follow-up prompt, add it to conversation history
      await addToConversationHistory(targetTabId, { 
        role: "user", 
        content: prompt 
      });
    }
    
    // Create callbacks for the agent
    const callbacks: ExecutionCallbacks = {
      onLlmChunk: (chunk) => {
        if (useStreaming) {
          // Get the window ID for this tab
          const windowId = getWindowForTab(targetTabId);
          
          // Add chunk to buffer
          addToStreamingBuffer(chunk, targetTabId, windowId);
        }
      },
      onLlmOutput: async (content) => {
        // For non-streaming mode, send the complete output
        if (!useStreaming) {
          sendUIMessage('updateOutput', {
            type: 'llm',
            content: content
          }, targetTabId);
        } else {
          // For streaming mode, store the final content to ensure it's not lost
          // This will be used in onComplete if needed
          setStreamingBuffer(content);
        }
        
        // If this is a reflection prompt, directly save the memory
        if (isReflectionPrompt) {
          // Get the domain from the current page
          try {
            updatedTabState.page.evaluate(() => window.location.href)
              .then((url: string) => {
                const domain = new URL(url).hostname;
                
                // Directly save the memory
                saveReflectionMemory(content, domain, targetTabId);
              })
              .catch((error: any) => {
                logWithTimestamp(`Error getting domain for reflection: ${error instanceof Error ? error.message : String(error)}`, 'error');
              });
          } catch (error) {
            logWithTimestamp(`Error in domain extraction for reflection: ${error instanceof Error ? error.message : String(error)}`, 'error');
          }
        }
        
        try {
          // Add the assistant's response to conversation history
          await addToConversationHistory(targetTabId, { role: "assistant", content: content });
          
          // Trim conversation history if it exceeds the token budget
          const history = await getStructuredMessageHistory(targetTabId);
          
          // Calculate the current token count of the conversation history
          const conversationTokens = contextTokenCount(history.conversationHistory);
          
          // If we're over budget, trim from the oldest messages until we're under budget
          if (conversationTokens > MAX_CONVERSATION_TOKENS) {
            logWithTimestamp(`Conversation history exceeds token budget (${conversationTokens}/${MAX_CONVERSATION_TOKENS}), trimming oldest messages`);
            
            // Remove oldest messages until we're under the token budget
            while (contextTokenCount(history.conversationHistory) > MAX_CONVERSATION_TOKENS && 
                   history.conversationHistory.length > 1) {
              // Remove the oldest message
              history.conversationHistory.shift();
            }
            
            // Get the window ID for this tab
            const windowId = getWindowForTab(targetTabId);
            if (windowId) {
              // Update the message history
              windowMessageHistories.set(windowId, history);
            }
            
            logWithTimestamp(`Trimmed conversation history to ${history.conversationHistory.length} messages (${contextTokenCount(history.conversationHistory)} tokens)`);
          }
        } catch (error) {
          logWithTimestamp(`Error updating conversation history: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
      },
      onToolOutput: (content) => {
        // Normal handling for tool outputs
        sendUIMessage('updateOutput', {
          type: 'system',
          content: content
        }, targetTabId);
      },
      onDebug: (label, detail) => {
        // Debug mode only: total-visibility trace rendered as a distinct block
        sendUIMessage('updateOutput', {
          type: 'debug',
          debugLabel: label,
          content: detail
        }, targetTabId);
      },
      onToolEnd: (result) => {
        // Check if this is a screenshot result by trying to parse it as JSON
        try {
          const data = JSON.parse(result);
          
          // Handle screenshot reference format
          if (data.type === "screenshotRef" && data.id) {
            // Get the screenshot manager
            const screenshotManager = ScreenshotManager.getInstance();
            
            // Get the screenshot data from the manager
            const screenshotData = screenshotManager.getScreenshot(data.id);
            
            if (screenshotData && 
                screenshotData.source && 
                screenshotData.source.data) {
              
              // Send special screenshot message to UI
              sendUIMessage('updateScreenshot', {
                type: 'screenshot',
                content: data.note || "Screenshot captured",
                imageData: screenshotData.source.data,
                mediaType: screenshotData.source.media_type || 'image/jpeg'
              }, targetTabId);
              
              logWithTimestamp(`Sent screenshot ${data.id} to UI for tab ${targetTabId}`);
            } else {
              logWithTimestamp(`Screenshot data not found for ID ${data.id}`, 'warn');
            }
          }
        } catch (error) {
          // Not JSON or not a screenshot, ignore
        }
      },
      onError: (error) => {
        // For retryable errors (rate limit or overloaded), show a message but don't complete processing
        if (error?.error?.type === 'rate_limit_error' || error?.error?.type === 'overloaded_error') {
          const errorType = error?.error?.type === 'overloaded_error' ? 'Server overloaded' : 'Rate limit exceeded';
          logWithTimestamp(`${errorType} error detected: ${JSON.stringify(error)}`, 'warn');
          
          sendUIMessage('updateOutput', {
            type: 'system',
            content: `⚠️ ${errorType}. Retrying... (${error.error.message})`
          }, targetTabId);
          
          // Explicitly tell the UI to stay in processing mode
          sendUIMessage('rateLimit', {
            isRetrying: true
          }, targetTabId);
        }
      },
      onFallbackStarted: () => {
        // Notify the UI that we're falling back but still processing
        logWithTimestamp("Fallback started, notifying UI to maintain processing state");
        sendUIMessage('fallbackStarted', {
          message: "Switching to fallback mode due to error. Processing continues..."
        }, targetTabId);
        
        // Explicitly tell the UI to stay in processing mode
        sendUIMessage('rateLimit', {
          isRetrying: true
        }, targetTabId);
      },
      onSegmentComplete: (segment) => {
        if (useStreaming) {
          // Get the window ID for this tab
          const windowId = getWindowForTab(targetTabId);
          
          // Finalize the current streaming segment
          finalizeStreamingSegment(getCurrentSegmentId(), segment, targetTabId, windowId);
          
          // Increment segment ID for the next segment
          incrementSegmentId();
        }
      },
      onToolStart: (toolName, toolInput) => {
        if (useStreaming) {
          // Get the window ID for this tab
          const windowId = getWindowForTab(targetTabId);
          
          // Start a new segment for after the tool execution
          startNewSegment(getCurrentSegmentId(), targetTabId, windowId);
        }
      },
      onComplete: () => {
        // Get the window ID for this tab
        const windowId = getWindowForTab(targetTabId);
        
        // Finalize the last segment if needed FIRST
        // This ensures the final LLM output is not lost
        if (useStreaming && getStreamingBuffer().trim()) {
          // Check if this segment contains a tool call
          const hasToolCall = /<tool>(.*?)<\/tool>\s*<input>([\s\S]*?)<\/input>/.test(getStreamingBuffer());
          
          // If it doesn't have a tool call, it's likely the final output
          if (!hasToolCall) {
            finalizeStreamingSegment(getCurrentSegmentId(), getStreamingBuffer(), targetTabId, windowId);
          }
        }
        
        // THEN clear any remaining buffer
        clearStreamingBuffer(targetTabId, windowId);
        
        // Signal that streaming is complete
        if (useStreaming) {
          signalStreamingComplete(targetTabId, windowId);
        }
        
        // Set agent status to IDLE
        if (windowId) {
          setAgentStatus(windowId, AgentStatus.IDLE);
        }
        
        sendUIMessage('processingComplete', null, targetTabId, windowId);
      }
    };
    
    // Get the agent for this window
    const updatedWindowId = updatedTabState.windowId;
    if (!updatedWindowId) {
      sendUIMessage('updateOutput', {
        type: 'system',
        content: `Error: No window ID found for tab ${targetTabId}.`
      }, targetTabId);
      sendUIMessage('processingComplete', null, targetTabId);
      return;
    }
    
    const agent = getAgentForWindow(updatedWindowId);
    
    if (!agent) {
      sendUIMessage('updateOutput', {
        type: 'system',
        content: `Error: No agent found for window ${updatedWindowId}.`
      }, targetTabId);
      sendUIMessage('processingComplete', null, targetTabId);
      return;
    }
    
    // Apply debug mode (read fresh so toggling in options takes effect on the
    // next task without recreating the agent).
    try {
      const debug = await ConfigManager.getInstance().getDebugMode();
      agent.setDebugMode(debug);
    } catch { /* non-blocking */ }

    // Execute the prompt with the agent
    const messageHistory = await getMessageHistory(targetTabId);

    // Auto-inject top-ranked memories for the current domain (once per
    // window+domain in this session) so the model starts with known patterns
    // without having to call lookup_memories itself. Also remember which
    // memories were in play, for outcome-based reinforcement.
    let taskDomain = '';
    if (!isReflectionPrompt) {
      try {
        const pageUrl = await updatedTabState.page.url();
        taskDomain = new URL(pageUrl).hostname;
        const injectionKey = `${updatedWindowId}:${taskDomain}`;
        if (taskDomain && !injectedMemoryDomains.has(injectionKey)) {
          await agent.injectMemoriesForDomain(taskDomain, messageHistory);
          injectedMemoryDomains.add(injectionKey);
        }
        if (taskDomain) {
          const ranked = await MemoryService.getInstance().getMemoriesByDomain(taskDomain).catch(() => []);
          lastTaskInfoByWindow.set(updatedWindowId, {
            domain: taskDomain,
            memoryIds: ranked.slice(0, 3).map(m => m.id!).filter(id => id !== undefined),
          });
        }
      } catch {
        // Non-blocking: continue without memory injection
      }

      // Start a fresh replayable action log for this task
      ActionLog.reset();

      // Explicit plan for long multi-step tasks: one LLM call, anchored in the
      // history so the model keeps a checklist against drift.
      if (prompt.length >= 120 && await ConfigManager.getInstance().getPlanningEnabled().catch(() => true)) {
        try {
          const lang = await getLang().catch(() => 'it' as const);
          const plan = await agent.generatePlan(prompt, lang === 'en' ? 'en' : 'it');
          if (plan) {
            messageHistory.push({
              role: 'user',
              content: lang === 'en'
                ? `[PLAN] Follow this plan, tick off steps as you complete them and stay on track:\n${plan}`
                : `[PIANO] Segui questo piano, spunta i passi man mano che li completi e non deviare:\n${plan}`,
            });
            sendUIMessage('updateOutput', { type: 'system', content: `📋 ${plan.split('\n')[0]}…` }, targetTabId);
          }
        } catch { /* planning is best-effort */ }
      }
    }

    await executePromptWithFallback(
      agent,
      prompt,
      callbacks,
      messageHistory,
      isReflectionPrompt ? 'observation' : 'automation'
    );

    // ── Outcome: reinforce memories, persist replayable recording, reflect ──
    if (!isReflectionPrompt) {
      try {
        const stats = agent.getLastRunStats();
        sendUIMessage('taskOutcome', { outcome: stats.outcome }, targetTabId, updatedWindowId);

        if (stats.outcome === 'success') {
          const info = lastTaskInfoByWindow.get(updatedWindowId);
          // Memories that were in play get reinforced by the real success
          if (info?.memoryIds?.length) {
            await MemoryService.getInstance().reinforceMemories(info.memoryIds).catch(() => undefined);
          }

          // Persist the action log as an auto-recording (replayable memory)
          if (taskDomain && ActionLog.size() >= 2) {
            const recordingName = `auto: ${taskDomain} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
            try {
              const recManager = RecordingManager.getInstance();
              await recManager.startRecording(recordingName).catch(() => undefined);
              for (const step of ActionLog.snapshot()) {
                await recManager.addStep(step).catch(() => undefined);
              }
              await recManager.stopRecording(`Auto-generata da task riuscito su ${taskDomain}`);
              setPendingRecordingName(recordingName);
            } catch { /* best-effort */ }
          }

          // Auto-reflection ONLY on successful, non-trivial tasks
          if (stats.toolCalls >= 3 && await MemoryManagerIsEnabled()) {
            triggerReflection(targetTabId);
          }
        }
      } catch { /* outcome handling is best-effort */ }
    }
  } catch (error) {
    const errorMessage = handleError(error, 'executing prompt');
    sendUIMessage('updateOutput', {
      type: 'system',
      content: `Error: ${errorMessage}`
    }, tabId);
    sendUIMessage('processingComplete', null, tabId);
  }
}
