import { ConfigManager } from "../background/configManager";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export class TokenTrackingService {
  private static instance: TokenTrackingService;

  // In-memory storage (no persistence)
  private inputTokens: number = 0;
  private outputTokens: number = 0;
  private cost: number = 0;

  // Provider and model tracking
  private configManager: ConfigManager;
  private currentProvider: string = 'openai-compatible';
  private currentModelId: string = '';

  // Subscribers for UI updates
  private subscribers: (() => void)[] = [];

  private constructor() {
    this.configManager = ConfigManager.getInstance();
    this.initializeProviderConfig();
  }

  public static getInstance(): TokenTrackingService {
    if (!TokenTrackingService.instance) {
      TokenTrackingService.instance = new TokenTrackingService();
    }
    return TokenTrackingService.instance;
  }

  private async initializeProviderConfig() {
    try {
      const config = await this.configManager.getProviderConfig();
      this.currentProvider = config.provider;
      this.currentModelId = config.apiModelId || '';
      this.updateCost(); // Recalculate with new provider/model
    } catch (error) {
      console.error('Failed to get provider config:', error);
    }
  }

  public trackInputTokens(tokens: number, cacheTokens?: { write?: number, read?: number }, windowId?: number): void {
    this.inputTokens += tokens;

    // Add cache tokens to the total if provided
    if (cacheTokens) {
      if (cacheTokens.write) this.inputTokens += cacheTokens.write;
      if (cacheTokens.read) this.inputTokens += cacheTokens.read;
    }

    this.updateCost();
    this.notifySubscribers(windowId);
  }

  public trackOutputTokens(tokens: number, windowId?: number): void {
    this.outputTokens += tokens;
    this.updateCost();
    this.notifySubscribers(windowId);
  }

  public getUsage(): TokenUsage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cost: this.cost
    };
  }

  public reset(windowId?: number): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cost = 0;
    this.notifySubscribers(windowId);
  }

  public subscribe(callback: () => void): () => void {
    this.subscribers.push(callback);
    return () => {
      this.subscribers = this.subscribers.filter(cb => cb !== callback);
    };
  }

  // Update provider and model information
  public updateProviderAndModel(provider: string, modelId: string, windowId?: number): void {
    this.currentProvider = provider;
    this.currentModelId = modelId;
    this.updateCost();
    this.notifySubscribers(windowId);
  }

  private updateCost(): void {
    // DomMotion uses a local/private openai-compatible endpoint — cost is always 0
    this.cost = 0;
  }

  private notifySubscribers(windowId?: number): void {
    // Send message to UI via Chrome runtime messaging
    try {
      const usage = this.getUsage();

      // Get the current tab ID and window ID if possible
      chrome.tabs.query({ active: true, lastFocusedWindow: true })
        .then(tabs => {
          const tabId = tabs[0]?.id;
          const currentWindowId = tabs[0]?.windowId || windowId;

          chrome.runtime.sendMessage({
            action: 'tokenUsageUpdated',
            content: usage,
            tabId,
            windowId: currentWindowId
          });
        })
        .catch(error => {
          // If we can't get the current tab, just send the message without tab/window ID
          console.error('Error getting current tab:', error);
          chrome.runtime.sendMessage({
            action: 'tokenUsageUpdated',
            content: usage
          });
        });
    } catch (error) {
      console.error('Error sending token usage update:', error);
    }

    // Also notify local subscribers
    this.subscribers.forEach(callback => {
      try {
        callback();
      } catch (error) {
        console.error('Error in subscriber callback:', error);
      }
    });
  }
}
