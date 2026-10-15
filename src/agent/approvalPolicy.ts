import type { MapEntry } from "./tools/pageMapTools";

/**
 * Approval policy decided by the EXTENSION (not by the model): before a
 * potentially irreversible action the operator must confirm.
 *
 * Modes:
 * - risky (default): deletions, payments/purchases, sending/publishing, final confirmations
 * - strict: also every save/submit
 * - off: never ask (operator's explicit choice)
 */

export type ApprovalMode = 'risky' | 'strict' | 'off';

const RISKY = [
  /\b(elimina|cancella|rimuovi|delete|remove|destroy|erase)\b/i,
  /\b(paga|pagamento|acquista|compra|ordina|checkout|pay|purchase|buy|place order)\b/i,
  /\b(invia|inoltra|pubblica|send|submit order|publish|post)\b/i,
  /\b(conferma|confirm|autorizza|authorize|approva|approve|firma|sign)\b/i,
];

const SUBMIT = [
  /\b(salva|registra|aggiungi|crea|aggiorna|save|submit|create|update|apply|applica)\b/i,
];

const ALWAYS_APPROVE: Record<string, string> = {
  clear_all_memories: 'Deletes all saved memories',
  delete_memory: 'Deletes a saved memory',
  browser_tab_close: 'Closes a browser tab',
};

export interface ApprovalContext {
  mode: ApprovalMode;
  /** Map entry targeted by a *_ref tool, when resolvable */
  entry?: MapEntry;
  /** The model flagged the call as risky (XML protocol) */
  modelFlag?: boolean;
}

/** Returns a human-readable reason when approval is needed, otherwise null. */
export function approvalReason(toolName: string, args: Record<string, any>, ctx: ApprovalContext): string | null {
  if (ctx.mode === 'off') return null;
  if (ALWAYS_APPROVE[toolName]) return ALWAYS_APPROVE[toolName];
  if (toolName === 'browser_tab' && String(args?.action) === 'close') return ALWAYS_APPROVE.browser_tab_close;

  const patterns = ctx.mode === 'strict' ? [...RISKY, ...SUBMIT] : RISKY;
  const label = ctx.entry ? `${ctx.entry.label}` : '';
  const target = label ? `"${label}"` : '';

  const clickLike = toolName === 'browser_click_ref' || toolName === 'browser_click' || toolName === 'browser_click_xy';
  const enterLike =
    (toolName === 'browser_press_key' && /^enter$/i.test(String(args?.key ?? args?.input ?? '').trim())) ||
    (toolName === 'browser_fill_ref' && args?.submit === true);

  // Navigation/selection widgets never commit anything by themselves
  const NON_COMMITTING = new Set(['tab', 'checkbox', 'radio', 'switch', 'textbox', 'select', 'combobox', 'option', 'treeitem', 'listbox', 'searchbox', 'spinbutton', 'slider']);
  if (clickLike && ctx.entry && NON_COMMITTING.has(ctx.entry.role)) return ctx.modelFlag ? 'The assistant flagged this action as requiring approval' : null;

  if (clickLike) {
    const text = label || String(args?.input ?? '');
    if (patterns.some(p => p.test(text))) return `Click on ${target || `"${text.slice(0, 60)}"`} may be irreversible`;
    if (ctx.entry && ctx.mode === 'strict' && ctx.entry.role === 'submit') return `Form submission via ${target}`;
  }
  if (enterLike && ctx.mode === 'strict') return `Pressing Enter may submit the form${target ? ` (${target})` : ''}`;

  if (ctx.modelFlag) return 'The assistant flagged this action as requiring approval';
  return null;
}
