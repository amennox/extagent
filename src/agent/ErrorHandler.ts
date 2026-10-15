/**
 * ErrorHandler handles cancellation logic, error recovery, and rate limit handling.
 */
export class ErrorHandler {
  private isCancelled: boolean = false;
  private cancelListeners = new Set<() => void>();

  /** Run `fn` when cancel() is called (e.g. abort an in-flight request). Returns an unsubscribe. */
  onCancel(fn: () => void): () => void {
    this.cancelListeners.add(fn);
    return () => { this.cancelListeners.delete(fn); };
  }
  
  constructor() {
    this.resetCancel();
  }
  
  /**
   * Cancel the current execution
   */
  cancel(): void {
    this.isCancelled = true;
    for (const fn of [...this.cancelListeners]) {
      try { fn(); } catch { /* ignore */ }
    }
  }
  
  /**
   * Reset the cancel flag
   */
  resetCancel(): void {
    this.isCancelled = false;
  }
  
  /**
   * Check if the execution has been cancelled
   */
  isExecutionCancelled(): boolean {
    return this.isCancelled;
  }
  
  /**
   * Check if an error is a rate limit error
   */
  isRateLimitError(error: any): boolean {
    return error?.error?.type === 'rate_limit_error';
  }
  
  /**
   * Check if an error is an overloaded error
   */
  isOverloadedError(error: any): boolean {
    return error?.error?.type === 'overloaded_error';
  }
  
  /**
   * Check if an error is a retryable error (rate limit or overloaded)
   */
  isRetryableError(error: any): boolean {
    return this.isRateLimitError(error) || this.isOverloadedError(error);
  }

  isContextOverflowError(error: any): boolean {
    const msg = (error?.message ?? '').toLowerCase();
    const status = error?.status ?? error?.statusCode ?? 0;
    if (status === 413 || status === 422) return true;
    if (status === 500 && (
      msg.includes('context_length') || msg.includes('too many tokens') ||
      msg.includes('maximum context') || msg.includes('request too large') ||
      msg.includes('token limit')
    )) return true;
    return false;
  }

  isCdpDisconnectedError(error: any): boolean {
    const msg = (error?.message ?? '').toLowerCase();
    return msg.includes('cdp session closed') || msg.includes('target closed') ||
      msg.includes('session closed') || msg.includes('frame has been detached');
  }
  
  /**
   * Format an error message for display
   */
  formatErrorMessage(error: any): string {
    if (this.isRateLimitError(error)) {
      return `Rate limit error: ${error.error.message}`;
    }
    
    if (this.isOverloadedError(error)) {
      return `Anthropic servers overloaded: ${error.error.message}. Retrying...`;
    }
    
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  
  /**
   * Calculate backoff time for retries based on error type and retry attempt
   * @param error The error that occurred
   * @param retryAttempt The current retry attempt (0-based)
   * @returns Time to wait in milliseconds before retrying
   */
  calculateBackoffTime(error: any, retryAttempt: number = 0): number {
    // Base backoff time
    let baseBackoff = 1000; // 1 second
    
    // For overloaded errors, use a longer base backoff
    if (this.isOverloadedError(error)) {
      baseBackoff = 2000; // 2 seconds
    }
    
    // Exponential backoff with jitter
    // 2^retryAttempt * baseBackoff + random jitter (up to 25%)
    const exponentialPart = Math.pow(2, Math.min(retryAttempt, 5)) * baseBackoff;
    const jitter = Math.random() * 0.25 * exponentialPart;
    
    return Math.floor(exponentialPart + jitter);
  }
  
  /**
   * Check if streaming is supported in the current environment
   */
  async isStreamingSupported(): Promise<boolean> {
    try {
      // Check if the browser supports the necessary features for streaming
      const supportsEventSource = typeof EventSource !== 'undefined';
      
      // We could also check for any browser-specific limitations
      const isCompatibleBrowser = !navigator.userAgent.includes('problematic-browser');
      
      return supportsEventSource && isCompatibleBrowser;
    } catch (error) {
      console.warn("Error checking streaming support:", error);
      return false;
    }
  }
}
