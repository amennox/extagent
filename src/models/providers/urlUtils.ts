/**
 * Shared helpers to make the OpenAI-compatible Base URL forgiving.
 *
 * Users paste the endpoint in many shapes:
 *   https://api-gb10.elettra.ai
 *   https://api-gb10.elettra.ai/
 *   https://api-gb10.elettra.ai/v1
 *   https://api-gb10.elettra.ai/v1/chat/completions
 * We normalize to the API root and, when a version segment is missing, default
 * to `/v1` (the near-universal convention for vLLM / LM Studio / TGI / elettra).
 */

/**
 * Normalize a user-entered Base URL to the API root.
 * - strips a trailing `/chat/completions` or `/completions`
 * - strips a trailing slash
 * - if the URL is origin-only (no path), appends `/v1`
 * Explicit paths (e.g. `/v1`, `/openai/v1`, a custom mount) are preserved.
 */
export function normalizeApiBase(input: string): string {
  let s = (input ?? '').trim();
  if (!s) return '';
  // Strip the full completions path if pasted
  s = s.replace(/\/+(?:v\d+\/)?chat\/completions\/?$/i, (m) =>
    // keep a leading /vN if present
    (/\/v\d+\//i.test(m) ? m.replace(/\/chat\/completions\/?$/i, '') : '')
  );
  s = s.replace(/\/completions\/?$/i, '');
  s = s.replace(/\/+$/, ''); // trailing slashes

  try {
    const u = new URL(s);
    if (u.pathname === '' || u.pathname === '/') {
      return `${u.origin}/v1`;
    }
  } catch {
    // Not a full URL (maybe missing scheme) — best-effort: append /v1 if no path
    if (!/\/[^/]+/.test(s.replace(/^https?:\/\//i, ''))) {
      return `${s}/v1`;
    }
  }
  return s;
}

/**
 * Candidate API roots to probe, most-likely first. Lets Test/Load self-heal
 * when the user's URL lacks (or wrongly includes) the version segment.
 */
export function apiBaseCandidates(input: string): string[] {
  const base = normalizeApiBase(input);
  const out = new Set<string>();
  out.add(base);
  // If it already ends with a version segment, also try without it (rare setups)
  if (/\/v\d+$/i.test(base)) {
    out.add(base.replace(/\/v\d+$/i, ''));
  } else {
    // and try an explicit /v1 variant
    out.add(`${base}/v1`);
  }
  return Array.from(out).filter(Boolean);
}

interface RawModel {
  id?: string;
  max_model_len?: number;
  context_length?: number;
  context_window?: number;
  n_ctx?: number;
  meta?: { n_ctx_train?: number };
}

export interface DiscoveredModel {
  id: string;
  contextWindow?: number;
}

/** Extract a context-window size from the many field names servers use. */
export function contextWindowFromModel(m: RawModel): number | undefined {
  const candidates = [
    m.max_model_len,
    m.context_length,
    m.context_window,
    m.n_ctx,
    m.meta?.n_ctx_train,
  ];
  const found = candidates.find((v) => typeof v === 'number' && v > 0);
  return found as number | undefined;
}

/** Parse an OpenAI `/models` response body into a simple model list. */
export function parseModelsResponse(body: any): DiscoveredModel[] {
  const data = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return data
    .filter((m: RawModel) => typeof m?.id === 'string' && m.id.length > 0)
    .map((m: RawModel) => ({ id: m.id as string, contextWindow: contextWindowFromModel(m) }));
}
