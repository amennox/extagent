const STORAGE_KEY = 'skills';

export type ParsedStepType = 'navigate' | 'extract' | 'paginate' | 'fill' | 'play' | 'export' | 'compute';

export interface ParsedStep {
  type: ParsedStepType;
  payload: string;
  raw: string;
  /** Variable name to store the step result in (from `→ salva in {{var}}`) */
  saveAs?: string;
}

export interface SkillDefinition {
  title: string;
  description: string;
  /** Declared parameters (frontmatter `params:`), substituted as {{param}} */
  params?: string[];
  steps: ParsedStep[];
  /** Free-text instruction lines (Level 3 — used by the LLM on exceptions) */
  notes?: string[];
  raw: string;
}

/** Parse the frontmatter `params:` field: `params: [a, b]` or `params: a, b`. */
function parseParams(frontmatter: string): string[] | undefined {
  const match = frontmatter.match(/^params:\s*(.+)$/m);
  if (!match) return undefined;
  const value = match[1].trim().replace(/^\[/, '').replace(/\]$/, '');
  const params = value.split(',').map(p => p.trim()).filter(p => p.length > 0);
  return params.length > 0 ? params : undefined;
}

/**
 * Parse a skill markdown string into a SkillDefinition.
 * Expects YAML frontmatter delimited by --- lines.
 * Special step commands are backtick-enclosed: `command: payload`
 * A step may store its result in a variable: `extract: {...}` → salva in {{ordini}}
 */
export function parseSkill(markdown: string): SkillDefinition {
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) throw new Error('Missing frontmatter: skill file must start with --- YAML block ---');

  const frontmatter = frontmatterMatch[1];
  const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? '';
  const description = descMatch?.[1]?.trim() ?? '';
  const params = parseParams(frontmatter);

  const body = markdown.slice(frontmatterMatch[0].length);
  const steps: ParsedStep[] = [];
  const notes: string[] = [];

  for (const line of body.split('\n')) {
    const cmdMatch = line.match(/`(navigate|extract|paginate|fill|play|export|compute):\s*([^`]*)`/);
    if (cmdMatch) {
      // Optional result variable: `…` → salva in {{var}}  (also: → {{var}})
      const saveMatch = line.match(/(?:→|->)\s*(?:salva\s+in\s+|save\s+(?:in|as)\s+)?\{\{\s*([\w-]+)\s*\}\}/i);
      steps.push({
        type: cmdMatch[1] as ParsedStepType,
        payload: cmdMatch[2].trim(),
        raw: line.trim(),
        saveAs: saveMatch?.[1],
      });
    } else {
      const text = line.trim();
      // Collect meaningful free-text lines (skip headings, list bullets alone, empty)
      if (text && !/^#/.test(text) && !/^[-*]\s*$/.test(text) && !/^\d+\.\s*$/.test(text)) {
        notes.push(text.replace(/^[-*\d.]+\s*/, ''));
      }
    }
  }

  return { title, description, params, steps, notes: notes.length ? notes : undefined, raw: markdown };
}

export class SkillManager {
  private static instance: SkillManager | null = null;

  static getInstance(): SkillManager {
    if (!SkillManager.instance) {
      SkillManager.instance = new SkillManager();
    }
    return SkillManager.instance;
  }

  async saveSkill(skill: SkillDefinition): Promise<void> {
    const all = await this._loadAll();
    all[skill.title] = skill;
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
  }

  async getSkill(title: string): Promise<SkillDefinition | null> {
    const all = await this._loadAll();
    // Exact match first
    if (all[title]) return all[title];
    // Case-insensitive exact match
    const lower = title.toLowerCase();
    const ciKey = Object.keys(all).find(k => k.toLowerCase() === lower);
    if (ciKey) return all[ciKey];
    // Partial match: title contains query or query contains title
    const partialKey = Object.keys(all).find(k =>
      k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase())
    );
    if (partialKey) return all[partialKey];
    return null;
  }

  async listSkills(): Promise<SkillDefinition[]> {
    const all = await this._loadAll();
    return Object.values(all);
  }

  async deleteSkill(title: string): Promise<void> {
    const all = await this._loadAll();
    delete all[title];
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
  }

  async importFromFile(content: string): Promise<SkillDefinition> {
    const skill = parseSkill(content);
    await this.saveSkill(skill);
    return skill;
  }

  exportToFile(skill: SkillDefinition): string {
    return skill.raw;
  }

  private async _loadAll(): Promise<Record<string, SkillDefinition>> {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return (result[STORAGE_KEY] as Record<string, SkillDefinition>) ?? {};
  }
}
