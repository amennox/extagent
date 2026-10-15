import { getLang, t } from "../i18n";
import { BrowserTool } from "./tools/types";

interface GenericMessage {
  role: string;
  content: string | any;
}

const STORAGE_KEY = 'agent_memories_v2';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface Memory {
  id: string;
  domain: string;
  pattern: string;
  toolSequence?: string[];
  selectors?: Record<string, string>;
  validated: boolean;
  createdAt: string;
  updatedAt: string;
  useCount: number;
}

/**
 * MemoryManager handles memory lookup and integration.
 */
export class MemoryManager {
  private memoryTool: BrowserTool | undefined;
  
  constructor(tools: BrowserTool[]) {
    // Find the memory lookup tool
    this.memoryTool = tools.find(t => t.name === "lookup_memories");
  }
  
  /**
   * Look up memories for a domain and add them to the message history
   * @param domain The domain to look up memories for
   * @param messages The messages array to add memories to
   */
  async lookupMemories(domain: string, messages: GenericMessage[]): Promise<void> {
    try {
      // Look up memories for this domain
      if (this.memoryTool) {
        const memoryResult = await this.memoryTool.func(domain);
        
        // If we found memories, add them to the context
        if (memoryResult && !memoryResult.startsWith("No memories found")) {
          try {
            const memories = JSON.parse(memoryResult);
            
            if (memories.length > 0) {
              // Add a system message about the memories
              const memoryContext = `I found ${memories.length} memories for ${domain}. Here are patterns that worked before:\n\n` +
                memories.map((m: any) => 
                  `Task: ${m.taskDescription}\nSteps: ${m.toolSequence.join(" → ")}`
                ).join("\n\n");
              
              // Add to messages
              messages.push({ 
                role: "user", 
                content: `Before we start, here are some patterns that worked well for tasks on this website before:\n\n${memoryContext}\n\nYou can adapt these patterns to the current task if relevant.` 
              });
            }
          } catch (error) {
            console.warn(`Error parsing memory results: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } catch (error) {
      console.warn(`Error looking up memories: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Update the memory tool
   */
  updateMemoryTool(tools: BrowserTool[]): void {
    this.memoryTool = tools.find(t => t.name === "lookup_memories");
  }

  // ── Storage-based memory CRUD ─────────────────────────────────────────────

  static async isMemoryEnabled(): Promise<boolean> {
    try {
      const result = await chrome.storage.sync.get({ memoryEnabled: true });
      return result.memoryEnabled !== false;
    } catch {
      return true;
    }
  }

  async saveMemory(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<Memory, 'id' | 'createdAt' | 'updatedAt'>>): Promise<void> {
    if (/<[^>]+>/.test(memory.pattern)) {
      const lang = await getLang().catch(() => 'it' as const);
      throw new Error(t('memory.noHtml', lang));
    }
    const all = await this._loadAll();
    const now = new Date().toISOString();
    const id = memory.id ?? (Math.random().toString(36).slice(2) + Date.now().toString(36));
    const idx = all.findIndex(m => m.id === id);
    const entry: Memory = {
      id,
      domain: memory.domain,
      pattern: memory.pattern,
      toolSequence: memory.toolSequence,
      selectors: memory.selectors,
      validated: memory.validated ?? false,
      createdAt: memory.createdAt ?? now,
      updatedAt: now,
      useCount: memory.useCount ?? 0,
    };
    if (idx >= 0) {
      all[idx] = entry;
    } else {
      all.push(entry);
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
  }

  async markValidated(id: string): Promise<void> {
    const all = await this._loadAll();
    const idx = all.findIndex(m => m.id === id);
    if (idx < 0) return;
    all[idx] = {
      ...all[idx],
      validated: true,
      useCount: all[idx].useCount + 1,
      updatedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
  }

  async deleteMemory(id: string): Promise<void> {
    const all = await this._loadAll();
    await chrome.storage.local.set({ [STORAGE_KEY]: all.filter(m => m.id !== id) });
  }

  async updateMemoryPattern(id: string, pattern: string): Promise<void> {
    const all = await this._loadAll();
    const idx = all.findIndex(m => m.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx], pattern, updatedAt: new Date().toISOString() };
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
  }

  async getSortedMemories(domain: string): Promise<Memory[]> {
    const all = await this._loadAll();
    const now = Date.now();
    const relevant = all.filter(m => {
      if (m.domain !== domain) return false;
      if (m.useCount === 0 && now - new Date(m.createdAt).getTime() > THIRTY_DAYS_MS) return false;
      return true;
    });
    return relevant.sort((a, b) => {
      if (a.validated !== b.validated) return a.validated ? -1 : 1;
      return b.useCount - a.useCount;
    });
  }

  async exportMemories(): Promise<string> {
    const all = await this._loadAll();
    return JSON.stringify(all, null, 2);
  }

  async importMemories(json: string): Promise<number> {
    const incoming: Memory[] = JSON.parse(json);
    const all = await this._loadAll();
    let count = 0;
    for (const m of incoming) {
      const duplicate = all.some(e => e.domain === m.domain && e.pattern === m.pattern);
      if (!duplicate) {
        all.push(m);
        count++;
      }
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
    return count;
  }

  private async _loadAll(): Promise<Memory[]> {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return (result[STORAGE_KEY] as Memory[]) ?? [];
  }
}
