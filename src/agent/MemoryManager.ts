import { MemoryService } from "../tracking/memoryService";

/**
 * MemoryManager: turns stored memories (MemoryService, single store) into a
 * compact hint for the task message, so the model starts with the patterns
 * that worked before without calling a lookup tool.
 */
export class MemoryManager {
  constructor(_tools: unknown[] = []) {}

  static async isMemoryEnabled(): Promise<boolean> {
    try {
      const result = await chrome.storage.sync.get({ memoryEnabled: true });
      return result.memoryEnabled !== false;
    } catch {
      return true;
    }
  }

  /** Top memories for a domain as a hint string (null when none). */
  async buildMemoryHint(domain: string, lang: 'it' | 'en' = 'it', limit = 3): Promise<{ hint: string; ids: number[] } | null> {
    try {
      const memories = (await MemoryService.getInstance().getMemoriesByDomain(domain)).slice(0, limit);
      if (!memories.length) return null;
      const lines = memories.map(m => {
        const steps = (m.toolSequence ?? []).slice(0, 8).join(' → ');
        return `- ${m.taskDescription}${m.validated ? (lang === 'en' ? ' (validated)' : ' (validata)') : ''}${steps ? `\n  ${steps}` : ''}`;
      });
      const header = lang === 'en'
        ? `Notes from previous tasks on ${domain} (adapt them, do not follow blindly):`
        : `Note da task precedenti su ${domain} (adattale, non seguirle alla cieca):`;
      return { hint: `${header}\n${lines.join('\n')}`, ids: memories.map(m => m.id!).filter(id => id !== undefined) };
    } catch (error) {
      console.warn('Memory hint failed:', error);
      return null;
    }
  }
}
