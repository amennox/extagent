import type { Page } from "playwright-crx";
import { ConfigManager, ProviderConfig } from "../background/configManager";
import { createProvider } from "../models/providers/factory";
import { AgentFunction, LLMProvider, ModelProfile } from "../models/providers/types";
import { ErrorHandler } from "./ErrorHandler";
import { ExecutionEngine, ExecutionCallbacks, DEFAULT_MAX_STEPS } from "./ExecutionEngine";
import { MemoryManager } from "./MemoryManager";
import { initializePageContext } from "./PageContextManager";
import { PromptManager } from "./PromptManager";
import { ToolManager } from "./ToolManager";
import { getAllTools } from "./tools/index";
import { BrowserTool, ToolExecutionContext } from "./tools/types";
// Define our own DynamicTool interface to avoid import issues
interface DynamicTool {
  name: string;
  description: string;
  func: (input: string) => Promise<string>;
}

// Type guard function to check if an object is a DynamicTool
function isDynamicTool(obj: any): obj is DynamicTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'name' in obj &&
    'description' in obj &&
    'func' in obj &&
    typeof obj.func === 'function'
  );
}

/**
 * BrowserAgent is the main class for the browser automation agent.
 * It coordinates all the components needed for execution.
 */
export class BrowserAgent {
  private llmProvider: LLMProvider;
  private toolManager: ToolManager;
  promptManager: PromptManager;
  private memoryManager: MemoryManager;
  private errorHandler: ErrorHandler;
  private executionEngine: ExecutionEngine;
  private configManager: ConfigManager;

  /**
   * Create a new BrowserAgent
   */
  constructor(page: Page, config: ProviderConfig, provider?: LLMProvider) {
    // Initialize the PageContextManager with the initial page
    initializePageContext(page);

    // Use the provided provider or create a new one
    this.llmProvider = provider!;

    // Get all tools from the tools module and convert them to BrowserTool objects
    const rawTools = getAllTools(page, this.llmProvider);
    const browserTools = this.convertToBrowserTools(rawTools);

    // Initialize all the components
    this.toolManager = new ToolManager(page, browserTools);
    this.promptManager = new PromptManager(this.toolManager.getTools());
    this.memoryManager = new MemoryManager(this.toolManager.getTools());
    this.errorHandler = new ErrorHandler();

    this.configManager = ConfigManager.getInstance();

    // Initialize the execution engine with all the components
    this.executionEngine = new ExecutionEngine(
      this.llmProvider,
      this.toolManager,
      this.promptManager,
      this.memoryManager,
      this.errorHandler,
      this.configManager
    );
  }

  /**
   * Convert tools from DynamicTool to BrowserTool format
   * This is needed because the tools are created using langchain's DynamicTool,
   * but our ToolManager expects BrowserTool objects.
   */
  private convertToBrowserTools(tools: any[]): BrowserTool[] {
    return tools.map(tool => {
      if (isDynamicTool(tool)) {
        // Convert DynamicTool to BrowserTool
        return {
          name: tool.name,
          description: tool.description,
          func: async (input: string, _context?: ToolExecutionContext) => {
            // Call the original function, ignoring any extra parameters
            return await tool.func(input);
          }
        };
      } else if (typeof tool === 'object' && 'name' in tool && 'description' in tool && 'func' in tool) {
        // Already in the right format or close enough
        return tool as BrowserTool;
      } else {
        // Fallback for any other format
        console.warn(`Unknown tool format for tool: ${JSON.stringify(tool)}`);
        return {
          name: tool.name || 'unknown_tool',
          description: tool.description || 'Unknown tool',
          func: async (input: string) => {
            try {
              if (typeof tool.func === 'function') {
                return await tool.func(input);
              }
              return `Error: Tool function not available`;
            } catch (error) {
              return `Error executing tool: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
        };
      }
    });
  }

  /**
   * Cancel the current execution
   */
  cancel(): void {
    this.errorHandler.cancel();
  }

  /**
   * Reset the cancel flag
   */
  resetCancel(): void {
    this.errorHandler.resetCancel();
  }

  /**
   * Set the active model profile for this execution session
   */
  setActiveProfile(profile: ModelProfile | null): void {
    this.executionEngine.setActiveProfile(profile);
  }

  setMaxSteps(n: number): void { this.executionEngine.setMaxSteps(n); }
  setMinMsBetweenCalls(ms: number): void { this.executionEngine.setMinMsBetweenCalls(ms); }
  setDebugMode(enabled: boolean): void { this.executionEngine.setDebugMode(enabled); }
  getLastRunStats() { return this.executionEngine.getLastRunStats(); }

  /** One-shot plan generation for long multi-step tasks (Level: single LLM call). */
  async generatePlan(prompt: string, lang: 'it' | 'en'): Promise<string | null> {
    try {
      const system = lang === 'it'
        ? 'Sei un pianificatore. Dato un compito di automazione browser, produci un piano di 3-6 passi numerati, brevi e concreti. SOLO il piano, nessun altro testo.'
        : 'You are a planner. Given a browser automation task, produce a numbered plan of 3-6 short, concrete steps. ONLY the plan, no other text.';
      const stream = this.llmProvider.createMessage(system, [{ role: 'user', content: prompt }], undefined, undefined);
      let text = '';
      for await (const chunk of stream) {
        if (chunk.type === 'text' && chunk.text) text += chunk.text;
      }
      text = text.trim();
      return text.length > 10 && text.length < 2000 ? text : null;
    } catch {
      return null;
    }
  }

  /**
   * Auto-inject the top-ranked memories for a domain into the message history
   * (validated first). Called at task start so the model doesn't need to
   * remember to invoke lookup_memories itself. Non-blocking on failure.
   */
  async injectMemoriesForDomain(domain: string, messages: any[]): Promise<void> {
    try {
      if (!(await MemoryManager.isMemoryEnabled())) return;
      await this.memoryManager.lookupMemories(domain, messages);
    } catch (error) {
      console.warn('Memory auto-injection failed (continuing without):', error);
    }
  }

  /**
   * Check if streaming is supported in the current environment
   */
  async isStreamingSupported(): Promise<boolean> {
    return this.errorHandler.isStreamingSupported();
  }

  /**
   * Execute a prompt with fallback support.
   * If agentFunction is provided, the matching profile is resolved and set before execution.
   */
  async executePromptWithFallback(
    prompt: string,
    callbacks: ExecutionCallbacks,
    initialMessages: any[] = [],
    agentFunction?: AgentFunction
  ): Promise<void> {
    if (agentFunction) {
      const profile = await this.configManager.resolveProfileForFunction(agentFunction)
        .catch(() => null);
      this.executionEngine.setActiveProfile(profile);
    }
    return this.executionEngine.executePromptWithFallback(
      prompt,
      callbacks,
      initialMessages
    );
  }

  /**
   * Execute a prompt without fallback
   */
  async executePrompt(
    prompt: string,
    callbacks: ExecutionCallbacks,
    initialMessages: any[] = []
  ): Promise<void> {
    return this.executionEngine.executePrompt(
      prompt,
      callbacks,
      initialMessages,
      false // Non-streaming mode
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Factory helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Create a new BrowserAgent
 */
export async function createBrowserAgent(
  page: Page,
  apiKey: string
): Promise<BrowserAgent> {
  // Get provider configuration
  const configManager = ConfigManager.getInstance();
  let providerConfig: ProviderConfig;

  try {
    providerConfig = await configManager.getProviderConfig();
  } catch (error) {
    console.warn('Failed to get provider configuration, using default:', error);
    providerConfig = {
      provider: 'openai-compatible',
      apiKey,
      apiModelId: '',
    };
  }

  // Use the provided API key as a fallback if the stored one is empty
  if (!providerConfig.apiKey) {
    providerConfig.apiKey = apiKey;
  }

  // Load model profiles
  const [profiles, defaultProfileId] = await Promise.all([
    configManager.getProfiles().catch(() => []),
    configManager.getDefaultProfileId().catch(() => ''),
  ]);

  // Create the provider with the configuration
  const provider = createProvider({
    apiKey: providerConfig.apiKey,
    apiModelId: providerConfig.apiModelId,
    baseUrl: providerConfig.baseUrl,
    openaiCompatibleModels: providerConfig.openaiCompatibleModels,
    profiles,
    defaultProfileId,
    dangerouslyAllowBrowser: true,
  });

  // Create the agent and set the active profile
  const agent = new BrowserAgent(page, providerConfig, provider);
  const activeProfile = await configManager.getActiveProfile().catch(() => null);
  agent.setActiveProfile(activeProfile);
  const maxSteps = await configManager.getMaxSteps().catch(() => DEFAULT_MAX_STEPS);
  agent.setMaxSteps(maxSteps);
  return agent;
}

/**
 * Check if the agent needs to be reinitialized due to provider change
 * @param agent The current agent
 * @param currentProvider The current provider configuration
 * @returns True if the agent needs to be reinitialized, false otherwise
 */
export async function needsReinitialization(
  agent: BrowserAgent,
  currentProvider?: ProviderConfig
): Promise<boolean> {
  if (!agent) return true;

  // Get current provider configuration if not provided
  if (!currentProvider) {
    const configManager = ConfigManager.getInstance();
    currentProvider = await configManager.getProviderConfig();
  }

  // Check if the provider has changed
  // We can't directly access the agent's provider, so we'll need to reinitialize
  // if the provider has changed in the config
  return true; // For now, always reinitialize to be safe
}

/**
 * Execute a prompt with the agent
 */
export async function executePrompt(
  agent: BrowserAgent,
  prompt: string,
  callbacks: ExecutionCallbacks,
  initialMessages: any[] = []
): Promise<void> {
  return agent.executePrompt(prompt, callbacks, initialMessages);
  // Note: The agent's executePrompt method now includes the isStreaming parameter
  // with a default value of false, so we don't need to pass it here
}

/**
 * Execute a prompt with fallback support
 */
export async function executePromptWithFallback(
  agent: BrowserAgent,
  prompt: string,
  callbacks: ExecutionCallbacks,
  initialMessages: any[] = [],
  agentFunction?: AgentFunction
): Promise<void> {
  return agent.executePromptWithFallback(prompt, callbacks, initialMessages, agentFunction);
}
