import type { Lang } from "../i18n";
import type { ChatMessage, ContentPart } from "../models/providers/types";
import type { EncodedImage } from "../utils/image";
import { getToolSpec, ObservationFamily, ToolKind } from "./toolCatalog";

/**
 * Agent working memory for ONE task, organised by turns (not by raw chat
 * messages), plus the policies that keep the context small and on-track:
 *
 * - Compaction: only the latest observation of each family (page map, page
 *   text, screenshot, …) is kept in full; older ones become a one-line
 *   placeholder. Old action results shrink to their first line. The model's
 *   own decisions are never dropped (they are small and carry the thread).
 * - Summary: when the rendered context still exceeds the budget, the oldest
 *   turns are condensed into a running summary by the engine.
 * - State: a fresh "[STATE]" message is appended at every step (active tab,
 *   plan checklist, open dialog, loop warnings), so the system prompt stays
 *   static (prefix caching) while the model always sees where it is.
 */

export const OBSERVATION_MARKER = 'Interactive elements (act with the [number]):';

export interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, any>;
  /** Legacy string input actually passed to the tool */
  input: string;
}

export interface ToolResultRecord {
  callId: string;
  name: string;
  text: string;
  image?: EncodedImage;
  kind: ToolKind;
  family?: ObservationFamily;
  mutating: boolean;
  isError: boolean;
  skipped?: boolean;
}

export interface TurnRecord {
  /** Visible assistant text (reasoning shown to the user, XML tool calls in XML mode) */
  text: string;
  calls: ToolCallRecord[];
  results: ToolResultRecord[];
  /** Engine feedback for this turn (format errors, empty responses) */
  feedback?: string;
  protocol: 'native' | 'xml';
}

export type PlanStatus = 'todo' | 'doing' | 'done';
export interface PlanStep { title: string; status: PlanStatus }

export function isErrorResult(text: string): boolean {
  return /^(Error\b|Errore\b|❌)/.test(text.trim());
}

/** Classify a tool result for compaction. */
export function classifyResult(name: string, text: string): { kind: ToolKind; family?: ObservationFamily; mutating: boolean } {
  const spec = getToolSpec(name);
  const kind: ToolKind = spec?.kind ?? 'action';
  let family = spec?.kind === 'observation' ? spec.family : undefined;
  // Any result that carries a full page observation (navigation, scroll,
  // click that changed page) supersedes earlier page observations.
  if (text.includes(OBSERVATION_MARKER)) family = 'page';
  return { kind: family ? 'observation' : kind, family, mutating: !!spec?.mutating };
}

const firstLine = (t: string) => t.split('\n')[0].slice(0, 200);

export class Transcript {
  turns: TurnRecord[] = [];
  summary: string | null = null;
  plan: PlanStep[] = [];

  addTurn(turn: TurnRecord): void {
    this.turns.push(turn);
  }

  get lastTurn(): TurnRecord | undefined {
    return this.turns[this.turns.length - 1];
  }

  /** Latest result (turn index, result index) per observation family. */
  latestByFamily(): Map<string, string> {
    const latest = new Map<string, string>();
    this.turns.forEach((turn, ti) => {
      turn.results.forEach((r, ri) => {
        if (r.family && !r.isError) latest.set(r.family, `${ti}:${ri}`);
      });
    });
    return latest;
  }

  /** Text of a result as it should appear in the context right now. */
  renderResult(ti: number, ri: number, latest = this.latestByFamily()): string {
    const r = this.turns[ti].results[ri];
    const age = this.turns.length - 1 - ti;
    if (r.isError) return r.text.length > 800 ? `${r.text.slice(0, 800)}…` : r.text;
    if (r.family) {
      if (latest.get(r.family) === `${ti}:${ri}`) return r.text;
      return `[Superseded by a newer observation] ${firstLine(r.text)}`;
    }
    if (r.kind === 'action' && age > 4) {
      return firstLine(r.text);
    }
    if (r.kind === 'data' && age > 8 && r.text.length > 3000) {
      return `${r.text.slice(0, 3000)}\n[…truncated in context]`;
    }
    return r.text;
  }

  /**
   * The newest screenshot, if still current: no state-changing action ran
   * after it (otherwise it would show a stale page).
   */
  currentImage(): { image?: EncodedImage; stale: boolean } | null {
    for (let ti = this.turns.length - 1; ti >= 0; ti--) {
      const results = this.turns[ti].results;
      for (let ri = results.length - 1; ri >= 0; ri--) {
        const r = results[ri];
        if (r.image) return { image: r.image, stale: false };
        if (r.mutating && !r.isError && !r.skipped) {
          // A later mutating action without image: any older image is stale
          return this.hasAnyImage(ti, ri) ? { stale: true } : null;
        }
      }
    }
    return null;
  }

  private hasAnyImage(ti: number, ri: number): boolean {
    for (let t = ti; t >= 0; t--) {
      const res = this.turns[t].results;
      const start = t === ti ? ri - 1 : res.length - 1;
      for (let r = start; r >= 0; r--) if (res[r].image) return true;
    }
    return false;
  }

  /** Compact text rendering of turns (for the summarizer and debug). */
  renderTurnsCompact(from: number, to: number): string {
    const latest = this.latestByFamily();
    const lines: string[] = [];
    for (let ti = from; ti < to; ti++) {
      const t = this.turns[ti];
      if (t.text.trim()) lines.push(`ASSISTANT: ${t.text.trim().slice(0, 600)}`);
      t.calls.forEach((c, ci) => {
        lines.push(`CALL ${c.name} ${JSON.stringify(c.args).slice(0, 300)}`);
        const r = t.results[ci];
        if (r) lines.push(`RESULT: ${this.renderResult(ti, ci, latest).slice(0, 1200)}`);
      });
    }
    return lines.join('\n');
  }

  /** Drop the oldest turns (already summarized), keeping the last `keep`. */
  dropOldest(keep: number): number {
    const n = Math.max(0, this.turns.length - keep);
    this.turns.splice(0, n);
    return n;
  }
}

// ── Rendering to chat messages ─────────────────────────────────────────────

export interface RenderInput {
  history: ChatMessage[];
  task: string;
  state: string;
  /** Image to attach to the state message (vision) */
  image?: EncodedImage | null;
  lang: Lang;
}

function withImage(text: string, image?: EncodedImage | null): string | ContentPart[] {
  if (!image) return text;
  return [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } },
  ];
}

export function renderMessages(t: Transcript, input: RenderInput): ChatMessage[] {
  const L = STRINGS[input.lang];
  const messages: ChatMessage[] = [...input.history];
  const first = t.summary
    ? `${input.task}\n\n${L.summaryHeader}\n${t.summary}`
    : input.task;
  messages.push({ role: 'user', content: first });

  const latest = t.latestByFamily();
  t.turns.forEach((turn, ti) => {
    const isLast = ti === t.turns.length - 1;
    if (turn.protocol === 'native') {
      // An assistant message needs text or tool_calls: an empty turn (all
      // output went into reasoning) is represented only by its feedback.
      if (!turn.calls.length && !turn.text.trim()) {
        if (turn.feedback && !isLast) messages.push({ role: 'user', content: turn.feedback });
        return;
      }
      messages.push({
        role: 'assistant',
        content: turn.text.trim() || null,
        tool_calls: turn.calls.length
          ? turn.calls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }))
          : undefined,
      });
      turn.calls.forEach((c, ci) => {
        messages.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: t.renderResult(ti, ci, latest) });
      });
      if (turn.feedback && !isLast) messages.push({ role: 'user', content: turn.feedback });
    } else {
      messages.push({ role: 'assistant', content: turn.text || '(empty)' });
      const parts: string[] = turn.calls.map((c, ci) => `${L.resultOf} ${c.name}:\n${t.renderResult(ti, ci, latest)}`);
      if (turn.feedback) parts.push(turn.feedback);
      if (isLast) {
        parts.push(input.state);
        messages.push({ role: 'user', content: withImage(parts.join('\n\n'), input.image) });
      } else if (parts.length) {
        messages.push({ role: 'user', content: parts.join('\n\n') });
      }
    }
  });

  const last = t.lastTurn;
  if (!last || last.protocol === 'native') {
    const stateText = last?.feedback ? `${last.feedback}\n\n${input.state}` : input.state;
    messages.push({ role: 'user', content: withImage(stateText, input.image) });
  }
  return messages;
}

/** Rough token estimate (chars/4, images ~1.2k tokens). */
export function estimateTokens(messages: ChatMessage[], systemPrompt = ''): number {
  let chars = systemPrompt.length;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') chars += p.text.length;
        else images++;
      }
    }
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4) + images * 1200;
}

// ── Loop detection ─────────────────────────────────────────────────────────

interface CallOutcome {
  signature: string;
  /** Short fingerprint of the result: same call + same result = no progress */
  resultKey?: string;
  name: string;
  isError: boolean;
  noChange: boolean;
  mutating: boolean;
  observation: boolean;
}

export interface LoopStatus {
  warning?: string;
  stop?: string;
}

/** Fingerprint of a tool result for loop detection (ignores timing noise). */
export function resultKey(text: string): string {
  const norm = text.replace(/stable after \d+ms/g, 'stable').replace(/\d+ms/g, '').slice(0, 2000);
  let h = 0;
  for (let i = 0; i < norm.length; i++) h = (h * 31 + norm.charCodeAt(i)) | 0;
  return `${norm.length}:${h}`;
}

export class LoopDetector {
  private history: CallOutcome[] = [];

  record(outcome: CallOutcome): void {
    this.history.push(outcome);
    if (this.history.length > 40) this.history.shift();
  }

  status(lang: Lang): LoopStatus {
    const L = STRINGS[lang];
    const last = this.history[this.history.length - 1];
    if (!last) return {};
    const window = this.history.slice(-10);
    const repeats = window.filter(o => o.signature === last.signature && o.resultKey === last.resultKey).length;
    const [warnAt, stopAt] = last.observation ? [4, 7] : [3, 5];
    if (repeats >= stopAt) return { stop: L.loopStop(last.name, repeats) };

    let errorStreak = 0;
    for (let i = this.history.length - 1; i >= 0 && this.history[i].isError; i--) errorStreak++;
    if (errorStreak >= 8) return { stop: L.errorStop(errorStreak) };

    let noChangeStreak = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const o = this.history[i];
      if (!o.mutating) continue;
      if (o.noChange) noChangeStreak++;
      else break;
    }

    if (repeats >= warnAt) return { warning: L.loopWarn(last.name, repeats) };
    if (errorStreak >= 4) return { warning: L.errorWarn(errorStreak) };
    if (noChangeStreak >= 3) return { warning: L.noChangeWarn(noChangeStreak) };
    return {};
  }
}

// ── State message ──────────────────────────────────────────────────────────

export interface StateInput {
  step: number;
  maxSteps: number;
  url?: string;
  title?: string;
  tabs?: number;
  plan: PlanStep[];
  dialog?: { type: string; message: string } | null;
  warning?: string;
  image: 'attached' | 'stale' | 'none';
  vision: boolean;
  lang: Lang;
}

export function buildStateMessage(s: StateInput): string {
  const L = STRINGS[s.lang];
  const lines: string[] = [L.stateHeader(s.step, s.maxSteps)];
  if (s.url) lines.push(`${L.activeTab}: ${s.title ? `"${s.title}" — ` : ''}${s.url}${s.tabs && s.tabs > 1 ? ` (${s.tabs} ${L.tabsOpen})` : ''}`);
  if (s.plan.length) {
    lines.push(`${L.plan}:`);
    s.plan.forEach((p, i) => {
      const mark = p.status === 'done' ? '✓' : p.status === 'doing' ? '→' : '·';
      lines.push(`  ${mark} ${i + 1}. ${p.title}`);
    });
  }
  if (s.dialog) lines.push(`⚠ ${L.dialogOpen(s.dialog.type, s.dialog.message)}`);
  if (s.warning) lines.push(`⚠ ${s.warning}`);
  if (s.image === 'attached') lines.push(L.imageAttached);
  else if (s.image === 'stale' && s.vision) lines.push(L.imageStale);
  if (s.maxSteps - s.step <= 3) lines.push(`⚠ ${L.fewStepsLeft(s.maxSteps - s.step)}`);
  lines.push(L.nextHint);
  return lines.join('\n');
}

// ── XML protocol (fallback for endpoints without native tool calling) ─────

export interface ParsedXmlCall {
  name: string;
  input: string;
  requiresApproval?: boolean;
}

const XML_CALL_RE = /<tool>\s*([\w.-]+)\s*<\/(?:tool|input|requires_approval)>\s*(?:<input>([\s\S]*?)<\/input>)?\s*(?:<requires_approval>\s*(true|false)\s*<\/requires_approval>)?/gi;

export function parseXmlToolCalls(text: string): ParsedXmlCall[] {
  const calls: ParsedXmlCall[] = [];
  const decoded = text.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>');
  for (const m of decoded.matchAll(XML_CALL_RE)) {
    calls.push({
      name: m[1].trim(),
      input: (m[2] ?? '').trim(),
      requiresApproval: m[3] ? m[3].toLowerCase() === 'true' : undefined,
    });
  }
  return calls;
}

/** Text has a tool tag but no parsable call: format error to report back. */
export function hasMalformedXmlCall(text: string): boolean {
  return /<tool>/i.test(text) && parseXmlToolCalls(text).length === 0;
}

/** Visible part of an XML-protocol response (text before the first call). */
export function stripXmlCalls(text: string): string {
  const idx = text.search(/(```(?:xml)?\s*)?<tool>/i);
  return (idx >= 0 ? text.slice(0, idx) : text).trim();
}

// ── Localized strings ──────────────────────────────────────────────────────

const STRINGS = {
  it: {
    summaryHeader: '[Riepilogo dei passi già svolti in questo task]',
    resultOf: 'Risultato di',
    stateHeader: (s: number, m: number) => `[STATO — passo ${s} di ${m}]`,
    activeTab: 'Tab attivo',
    tabsOpen: 'tab aperti',
    plan: 'Piano',
    dialogOpen: (type: string, msg: string) => `Dialog del browser aperto (${type}): "${msg.slice(0, 150)}". La pagina è bloccata finché non usi browser_handle_dialog.`,
    imageAttached: 'Screenshot allegato: vista attuale, i numeri disegnati corrispondono ai [n] dell\'ultima osservazione.',
    imageStale: 'Nessuno screenshot aggiornato dopo l\'ultima azione: chiama browser_observe se ti serve vedere la pagina.',
    fewStepsLeft: (n: number) => `Restano solo ${n} passi: concludi o riassumi cosa manca.`,
    nextHint: 'Procedi: agisci sui [numeri] dell\'ultima osservazione (puoi chiamare più tool in sequenza). Quando il compito è completo rispondi con il risultato finale, senza chiamare tool.',
    loopWarn: (name: string, n: number) => `Hai ripetuto ${name} con gli stessi argomenti ${n} volte senza progressi. Cambia strategia: osserva di nuovo (con screenshot), scorri, prova un altro elemento, oppure spiega all'utente cosa ti blocca.`,
    loopStop: (name: string, n: number) => `Mi sono fermato: stavo ripetendo ${name} (${n} volte) senza progressi. Dimmi come procedere o completa a mano il passaggio bloccato.`,
    errorWarn: (n: number) => `Le ultime ${n} azioni sono fallite. Fermati e osserva la pagina prima di riprovare; considera un approccio diverso.`,
    errorStop: (n: number) => `Mi sono fermato dopo ${n} errori consecutivi. Controlla la pagina e dimmi come proseguire.`,
    noChangeWarn: (n: number) => `Le ultime ${n} azioni non hanno cambiato nulla di visibile. Forse l'elemento è sbagliato, coperto o fuori vista: osserva con screenshot o scorri.`,
  },
  en: {
    summaryHeader: '[Summary of the steps already done in this task]',
    resultOf: 'Result of',
    stateHeader: (s: number, m: number) => `[STATE — step ${s} of ${m}]`,
    activeTab: 'Active tab',
    tabsOpen: 'tabs open',
    plan: 'Plan',
    dialogOpen: (type: string, msg: string) => `Browser dialog open (${type}): "${msg.slice(0, 150)}". The page is blocked until you use browser_handle_dialog.`,
    imageAttached: 'Screenshot attached: current view, the drawn numbers match the [n] of the latest observation.',
    imageStale: 'No up-to-date screenshot after the last action: call browser_observe if you need to see the page.',
    fewStepsLeft: (n: number) => `Only ${n} steps left: wrap up or summarize what is missing.`,
    nextHint: 'Continue: act on the [numbers] of the latest observation (you may call several tools in sequence). When the task is complete, reply with the final result without calling tools.',
    loopWarn: (name: string, n: number) => `You repeated ${name} with the same arguments ${n} times without progress. Change strategy: observe again (with screenshot), scroll, try another element, or explain to the user what blocks you.`,
    loopStop: (name: string, n: number) => `I stopped: I was repeating ${name} (${n} times) without progress. Tell me how to proceed or complete the blocked step manually.`,
    errorWarn: (n: number) => `The last ${n} actions failed. Stop and observe the page before retrying; consider a different approach.`,
    errorStop: (n: number) => `I stopped after ${n} consecutive errors. Check the page and tell me how to continue.`,
    noChangeWarn: (n: number) => `The last ${n} actions changed nothing visible. The element may be wrong, covered or out of view: observe with a screenshot or scroll.`,
  },
};

export function engineStrings(lang: Lang) {
  return STRINGS[lang];
}
