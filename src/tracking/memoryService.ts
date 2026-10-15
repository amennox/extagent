import { logWithTimestamp } from '../background/utils';
import defaultMemoriesData from './defaultMemories.json';
import { normalizeDomain } from './domainUtils';

export interface AgentMemory {
  id?: number;
  domain: string;  // Website domain as the key (e.g., "linkedin.com")
  taskDescription: string;  // Short description of what was accomplished
  toolSequence: string[];  // Array of tool calls with their inputs
  createdAt: number;  // Timestamp
  validated?: boolean;  // Operator-validated memories rank first
  useCount?: number;    // How many times the memory has been reused
  /** Linked auto-generated recording — makes the memory deterministically replayable */
  recordingName?: string;
}

/**
 * Unified storage record shared with agent/MemoryManager (options UI).
 * Single source of truth: chrome.storage.local under STORAGE_KEY.
 */
interface StoredMemory {
  id: string;
  domain: string;
  pattern: string;
  toolSequence?: string[];
  selectors?: Record<string, string>;
  validated: boolean;
  createdAt: string;   // ISO
  updatedAt: string;   // ISO
  useCount: number;
  recordingName?: string;
}

const STORAGE_KEY = 'agent_memories_v2';
/** Max memories kept per domain: beyond this the lowest-ranked provisional ones are pruned. */
const MAX_MEMORIES_PER_DOMAIN = 15;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
/** A provisional memory reused successfully this many times gets auto-validated. */
const AUTO_VALIDATE_USES = 2;

function toAgentMemory(m: StoredMemory): AgentMemory {
  return {
    id: Number(m.id),
    domain: m.domain,
    taskDescription: m.pattern,
    toolSequence: m.toolSequence ?? [],
    createdAt: Date.parse(m.createdAt) || 0,
    validated: m.validated,
    useCount: m.useCount,
    recordingName: m.recordingName,
  };
}

/**
 * MemoryService — persistence for agent memories.
 *
 * NOTE: previously IndexedDB-backed; now persists to the SAME
 * chrome.storage.local key used by agent/MemoryManager, so agent tools,
 * options UI, default seeding and reflection all share one store.
 * The public API is unchanged.
 */
export class MemoryService {
  private static instance: MemoryService;
  private hasImportedDefaultMemories = false;

  public static getInstance(): MemoryService {
    if (!MemoryService.instance) {
      MemoryService.instance = new MemoryService();
    }
    return MemoryService.instance;
  }

  private constructor() {
    // Singleton
  }

  /** Kept for API compatibility — storage needs no async initialization. */
  public async init(): Promise<void> {
    return Promise.resolve();
  }

  private async _loadAll(): Promise<StoredMemory[]> {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return (result[STORAGE_KEY] as StoredMemory[]) ?? [];
  }

  private async _saveAll(all: StoredMemory[]): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: all });
  }

  /**
   * Check if a similar memory already exists (same domain + task description).
   */
  public async findSimilarMemory(memory: AgentMemory): Promise<number | null> {
    const normalizedDomain = normalizeDomain(memory.domain);
    const all = await this._loadAll();
    const similar = all.find(m =>
      m.domain === normalizedDomain &&
      m.pattern.toLowerCase() === memory.taskDescription.toLowerCase()
    );
    if (similar) {
      const id = Number(similar.id);
      if (!isNaN(id)) return id;
    }
    return null;
  }

  /** Update an existing memory by numeric ID. */
  public async updateMemory(id: number, memory: Partial<AgentMemory>): Promise<number> {
    const all = await this._loadAll();
    const idx = all.findIndex(m => m.id === String(id));
    if (idx < 0) {
      throw new Error(`Memory with ID ${id} not found`);
    }
    const existing = all[idx];
    all[idx] = {
      ...existing,
      domain: memory.domain !== undefined ? normalizeDomain(memory.domain) : existing.domain,
      pattern: memory.taskDescription ?? existing.pattern,
      toolSequence: memory.toolSequence ?? existing.toolSequence,
      validated: memory.validated ?? existing.validated,
      useCount: memory.useCount ?? existing.useCount,
      recordingName: memory.recordingName ?? existing.recordingName,
      updatedAt: new Date().toISOString(),
    };
    await this._saveAll(all);
    logWithTimestamp(`Successfully updated memory with ID ${id}`);
    return id;
  }

  /** Store a new memory (deduplicated on domain + task description). */
  public async storeMemory(memory: AgentMemory): Promise<number> {
    memory.domain = normalizeDomain(memory.domain);

    const existingId = await this.findSimilarMemory(memory);
    if (existingId !== null) {
      logWithTimestamp(`Similar memory found with ID ${existingId}, updating instead of creating duplicate`);
      return this.updateMemory(existingId, memory);
    }

    const all = await this._loadAll();
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const nowIso = new Date(memory.createdAt || Date.now()).toISOString();
    all.push({
      id: String(id),
      domain: memory.domain,
      pattern: memory.taskDescription,
      toolSequence: memory.toolSequence,
      validated: memory.validated ?? false,
      createdAt: nowIso,
      updatedAt: nowIso,
      useCount: memory.useCount ?? 0,
      recordingName: memory.recordingName,
    });

    // Per-domain cap: prune the lowest-ranked provisional memories beyond the cap
    const domainMemories = all.filter(m => m.domain === memory.domain);
    if (domainMemories.length > MAX_MEMORIES_PER_DOMAIN) {
      const pruneCount = domainMemories.length - MAX_MEMORIES_PER_DOMAIN;
      const pruneCandidates = domainMemories
        .filter(m => !m.validated && m.id !== String(id))
        .sort((a, b) => (a.useCount ?? 0) - (b.useCount ?? 0) ||
          (Date.parse(a.updatedAt) || 0) - (Date.parse(b.updatedAt) || 0));
      const toPrune = new Set(pruneCandidates.slice(0, pruneCount).map(m => m.id));
      if (toPrune.size > 0) {
        logWithTimestamp(`Domain ${memory.domain} over memory cap: pruning ${toPrune.size} provisional memories`);
        for (let i = all.length - 1; i >= 0; i--) {
          if (toPrune.has(all[i].id)) all.splice(i, 1);
        }
      }
    }

    await this._saveAll(all);
    logWithTimestamp(`Successfully stored memory with ID ${id} for domain ${memory.domain}`);
    return id;
  }

  /**
   * Positive outcome/feedback: increment useCount on the given memories and
   * auto-validate the provisional ones reused successfully enough times
   * (or immediately when `forceValidate` — explicit 👍).
   */
  public async reinforceMemories(ids: number[], forceValidate = false): Promise<void> {
    if (!ids.length) return;
    const idSet = new Set(ids.map(String));
    const all = await this._loadAll();
    let touched = false;
    for (const m of all) {
      if (!idSet.has(m.id)) continue;
      m.useCount = (m.useCount ?? 0) + 1;
      if (forceValidate || m.useCount >= AUTO_VALIDATE_USES) m.validated = true;
      m.updatedAt = new Date().toISOString();
      touched = true;
    }
    if (touched) await this._saveAll(all);
  }

  /**
   * Negative outcome/feedback: delete provisional memories, weaken validated
   * ones (a validated memory that keeps failing eventually gets removed).
   */
  public async penalizeMemories(ids: number[]): Promise<void> {
    if (!ids.length) return;
    const idSet = new Set(ids.map(String));
    const all = await this._loadAll();
    const kept: StoredMemory[] = [];
    let touched = false;
    for (const m of all) {
      if (!idSet.has(m.id)) { kept.push(m); continue; }
      touched = true;
      if (!m.validated) continue; // provisional + negative signal → drop
      m.useCount = Math.max(0, (m.useCount ?? 0) - 1);
      if (m.useCount === 0) m.validated = false; // demote back to provisional
      m.updatedAt = new Date().toISOString();
      kept.push(m);
    }
    if (touched) await this._saveAll(kept);
  }

  /**
   * Retrieve memories by domain, ranked: validated first, then by useCount,
   * then most recent. Unused memories older than 30 days are filtered out.
   */
  public async getMemoriesByDomain(domain: string): Promise<AgentMemory[]> {
    const normalizedDomain = normalizeDomain(domain);
    const all = await this._loadAll();
    const now = Date.now();

    const relevant = all.filter(m => {
      if (m.domain !== normalizedDomain) return false;
      const lastTouch = Date.parse(m.updatedAt) || Date.parse(m.createdAt) || 0;
      // Decay: unused provisional memories after 30 days, validated after 90
      if ((m.useCount ?? 0) === 0 && now - (Date.parse(m.createdAt) || 0) > THIRTY_DAYS_MS) return false;
      if (m.validated && now - lastTouch > NINETY_DAYS_MS) return false;
      return true;
    });

    relevant.sort((a, b) => {
      if (a.validated !== b.validated) return a.validated ? -1 : 1;
      if ((b.useCount ?? 0) !== (a.useCount ?? 0)) return (b.useCount ?? 0) - (a.useCount ?? 0);
      return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
    });

    logWithTimestamp(`Retrieved ${relevant.length} memories for domain ${domain}`);
    return relevant.map(toAgentMemory);
  }

  /** Get all memories. */
  public async getAllMemories(): Promise<AgentMemory[]> {
    const all = await this._loadAll();
    logWithTimestamp(`Retrieved ${all.length} total memories`);
    return all.map(toAgentMemory);
  }

  /** Delete a memory by numeric ID. */
  public async deleteMemory(id: number): Promise<void> {
    const all = await this._loadAll();
    await this._saveAll(all.filter(m => m.id !== String(id)));
    logWithTimestamp(`Successfully deleted memory with ID ${id}`);
  }

  /** Clear all memories. */
  public async clearMemories(): Promise<void> {
    await this._saveAll([]);
    logWithTimestamp(`Successfully cleared all memories`);
  }

  /**
   * Import default memories from the bundled JSON file (only when the store
   * is empty, typically on fresh install).
   */
  public async importDefaultMemories(): Promise<number> {
    if (this.hasImportedDefaultMemories) {
      logWithTimestamp('Default memories already imported, skipping');
      return 0;
    }

    const existing = await this.getAllMemories();
    if (existing.length > 0) {
      logWithTimestamp('Store already contains memories, skipping default import');
      this.hasImportedDefaultMemories = true;
      return 0;
    }

    const defaultMemories: AgentMemory[] = defaultMemoriesData as AgentMemory[];
    if (!Array.isArray(defaultMemories) || defaultMemories.length === 0) {
      logWithTimestamp('No default memories found or invalid format', 'warn');
      this.hasImportedDefaultMemories = true;
      return 0;
    }

    let importedCount = 0;
    for (const memory of defaultMemories) {
      try {
        delete memory.id;
        await this.storeMemory(memory);
        importedCount++;
      } catch (error) {
        logWithTimestamp(`Error importing memory: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      }
    }

    logWithTimestamp(`Successfully imported ${importedCount} default memories`);
    this.hasImportedDefaultMemories = true;
    return importedCount;
  }
}
