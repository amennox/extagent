const KEY_RECORDINGS = 'recordings';
const KEY_ACTIVE = 'activeRecording';

export interface RecordingStep {
  type: 'click' | 'type' | 'navigate' | 'select' | 'check' | 'press' | 'wait';
  /** Primary CSS selector */
  selector?: string;
  /** Alternative locators, most robust first (used by self-healing replay) */
  candidates?: string[];
  /** Typed text / selected value / pressed key */
  text?: string;
  /** Target URL for navigate steps */
  url?: string;
  /** Page context at capture time */
  pageUrl?: string;
  pageTitle?: string;
  /** Visible text of the target element (buttons, links) */
  elementText?: string;
  /** Associated label text (form fields) */
  elementLabel?: string;
  /** Short snippet of surrounding content (max ~300 chars) */
  context?: string;
  /** @deprecated kept for backward compatibility with old recordings */
  snapshotBefore?: string;
  description?: string;
  timestamp?: number;
}

export interface Recording {
  name: string;
  description: string;
  createdAt: string;
  steps: RecordingStep[];
}

interface ActiveRecording {
  name: string;
  steps: RecordingStep[];
}

export class RecordingManager {
  private static instance: RecordingManager | null = null;

  static getInstance(): RecordingManager {
    if (!RecordingManager.instance) {
      RecordingManager.instance = new RecordingManager();
    }
    return RecordingManager.instance;
  }

  async startRecording(name: string): Promise<void> {
    const active = await this._getActive();
    if (active !== null) {
      throw new Error(`Recording already active: "${active.name}"`);
    }
    const newActive: ActiveRecording = { name, steps: [] };
    await chrome.storage.local.set({ [KEY_ACTIVE]: newActive });
  }

  async addStep(step: RecordingStep): Promise<void> {
    const active = await this._getActive();
    if (!active) throw new Error('No active recording');
    active.steps.push(step);
    await chrome.storage.local.set({ [KEY_ACTIVE]: active });
  }

  async stopRecording(description: string = ''): Promise<Recording> {
    const active = await this._getActive();
    if (!active) throw new Error('No active recording to stop');
    const recording: Recording = {
      name: active.name,
      description,
      createdAt: new Date().toISOString(),
      steps: active.steps,
    };
    const all = await this._loadAll();
    all[recording.name] = recording;
    await chrome.storage.local.set({ [KEY_RECORDINGS]: all, [KEY_ACTIVE]: null });
    return recording;
  }

  async cancelRecording(): Promise<void> {
    await chrome.storage.local.set({ [KEY_ACTIVE]: null });
  }

  async getRecording(name: string): Promise<Recording | null> {
    const all = await this._loadAll();
    return all[name] ?? null;
  }

  async listRecordings(): Promise<Recording[]> {
    const all = await this._loadAll();
    return Object.values(all);
  }

  async deleteRecording(name: string): Promise<void> {
    const all = await this._loadAll();
    delete all[name];
    await chrome.storage.local.set({ [KEY_RECORDINGS]: all });
  }

  async isRecording(): Promise<boolean> {
    const active = await this._getActive();
    return active !== null;
  }

  private async _getActive(): Promise<ActiveRecording | null> {
    const result = await chrome.storage.local.get(KEY_ACTIVE);
    const val = result[KEY_ACTIVE];
    return val ?? null;
  }

  private async _loadAll(): Promise<Record<string, Recording>> {
    const result = await chrome.storage.local.get(KEY_RECORDINGS);
    return (result[KEY_RECORDINGS] as Record<string, Recording>) ?? {};
  }
}
