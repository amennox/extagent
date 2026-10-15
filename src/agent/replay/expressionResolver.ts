/**
 * Expression resolver for hybrid replay (Level 1 — no LLM).
 *
 * Supported {{…}} expressions:
 * - Dates:   {{oggi}} / {{today}}   with optional offset and format:
 *            {{oggi+7g}}, {{oggi-1g:GG/MM/AAAA}}, {{today+2d:YYYY-MM-DD}}
 * - Time:    {{ora}} / {{now}} → HH:MM
 * - Params:  {{nome_param}} → from ctx.params (skill/replay parameters)
 * - Vars:    {{var}} / {{var.path[0].field}} → from ctx.variables
 *            (results of previous steps: extract, compute, …)
 *
 * Unknown expressions are left untouched so callers (wizard, LLM fallback)
 * can detect and handle them.
 */

export interface ReplayContext {
  params: Record<string, string>;
  variables: Record<string, unknown>;
}

export function createReplayContext(params: Record<string, string> = {}): ReplayContext {
  return { params: { ...params }, variables: {} };
}

const DATE_KEYWORDS = new Set(['oggi', 'today']);
const TIME_KEYWORDS = new Set(['ora', 'now']);

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format tokens: GG|DD = day, MM = month, AAAA|YYYY = year. Default ISO. */
function formatDate(d: Date, fmt?: string): string {
  if (!fmt) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return fmt
    .replace(/AAAA|YYYY/g, String(d.getFullYear()))
    .replace(/GG|DD/g, pad(d.getDate()))
    .replace(/MM/g, pad(d.getMonth() + 1));
}

/** Resolve a dotted/indexed path (e.g. "ordini.items[0].numero") in an object. */
export function resolvePath(root: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(s => s.length > 0);
  let current: any = root;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    current = current[seg];
  }
  return current;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Resolve a single expression body (content between {{ and }}).
 * Returns undefined when the expression cannot be resolved.
 */
export function resolveExpression(body: string, ctx: ReplayContext, now: Date = new Date()): string | undefined {
  const trimmed = body.trim();

  // Date with optional offset/format: oggi | oggi+7g | oggi-2g:GG/MM/AAAA
  const dateMatch = trimmed.match(/^(oggi|today)(?:\s*([+-])\s*(\d+)\s*[gd])?(?::(.+))?$/i);
  if (dateMatch && DATE_KEYWORDS.has(dateMatch[1].toLowerCase())) {
    const d = new Date(now);
    if (dateMatch[2] && dateMatch[3]) {
      const offset = parseInt(dateMatch[3], 10) * (dateMatch[2] === '-' ? -1 : 1);
      d.setDate(d.getDate() + offset);
    }
    return formatDate(d, dateMatch[4]?.trim());
  }

  // Time: ora | now
  if (TIME_KEYWORDS.has(trimmed.toLowerCase())) {
    return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  // Params take priority (exact key)
  if (Object.prototype.hasOwnProperty.call(ctx.params, trimmed)) {
    return ctx.params[trimmed];
  }

  // Variables: exact key or path
  const rootKey = trimmed.split(/[.[]/, 1)[0];
  if (Object.prototype.hasOwnProperty.call(ctx.variables, rootKey)) {
    const value = rootKey === trimmed
      ? ctx.variables[rootKey]
      : resolvePath(ctx.variables[rootKey], trimmed.slice(rootKey.length));
    return stringifyValue(value);
  }

  return undefined;
}

/**
 * Resolve every {{…}} expression in a text. Unresolvable expressions are left
 * as-is. Returns the resolved text plus the list of unresolved expressions.
 */
export function resolveExpressions(
  text: string,
  ctx: ReplayContext,
  now: Date = new Date()
): { resolved: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const resolved = text.replace(/\{\{([^{}]+)\}\}/g, (match, body) => {
    const value = resolveExpression(body, ctx, now);
    if (value === undefined) {
      unresolved.push(body.trim());
      return match;
    }
    return value;
  });
  return { resolved, unresolved };
}
