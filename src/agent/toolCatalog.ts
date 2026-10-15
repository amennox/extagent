import type { Lang } from "../i18n";
import { TOOL_DESCRIPTIONS_EN } from "./tools/descriptions.en";
import { TOOL_DESCRIPTIONS_IT } from "./tools/descriptions.it";

/**
 * Tool catalog: metadata the engine needs on top of the tool implementations.
 *
 * - tier: which tools are exposed to the model. A small "core" set (~15) keeps
 *   the prompt focused; "vision" tools are added for vision models; "advanced"
 *   tools are hidden unless enabled in settings (still callable by name).
 * - kind/family: drive context compaction (older observations of the same
 *   family are replaced by a one-line placeholder) and loop detection.
 * - schema/toInput: real JSON schemas for native function calling, mapped to
 *   the legacy string input of each tool implementation.
 */

export type ToolTier = 'core' | 'vision' | 'advanced';
export type ToolKind = 'observation' | 'action' | 'data' | 'meta';
export type ObservationFamily = 'page' | 'text' | 'image' | 'tabs' | 'dom';

export interface ToolSpec {
  name: string;
  tier: ToolTier;
  kind: ToolKind;
  family?: ObservationFamily;
  /** Changes the page state (loop detection, batch safety) */
  mutating?: boolean;
  schema: Record<string, unknown>;
  toInput: (args: Record<string, any>) => string;
  description: { it: string; en: string };
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const json = (args: Record<string, any>) => JSON.stringify(args ?? {});
const str = (key: string) => (args: Record<string, any>) => args?.[key] === undefined ? '' : String(args[key]);
const legacyInput = obj({ input: { type: 'string', description: 'Tool input' } });
const legacy = (args: Record<string, any>) => (args?.input === undefined ? '' : String(args.input));

const REF = { type: 'integer', description: 'Element number [n] from the latest observation' };

const CORE: ToolSpec[] = [
  {
    name: 'browser_observe', tier: 'core', kind: 'observation', family: 'page',
    schema: obj({ screenshot: { type: 'boolean', description: 'Attach an annotated screenshot (vision models). Default: on for vision models.' } }),
    toInput: json,
    description: {
      it: 'Osserva la pagina: elementi interattivi NUMERATI [n] (ruolo, etichetta, valore, stato), messaggi della pagina (errori, toast), posizione di scroll e quanti elementi ci sono sopra/sotto. Sui modelli vision allega uno screenshot con gli stessi numeri disegnati.',
      en: 'Observe the page: NUMBERED interactive elements [n] (role, label, value, state), page messages (errors, toasts), scroll position and how many elements are above/below. On vision models it attaches a screenshot with the same numbers drawn on it.',
    },
  },
  {
    name: 'browser_click_ref', tier: 'core', kind: 'action', mutating: true,
    schema: obj({ ref: REF }, ['ref']), toInput: str('ref'),
    description: {
      it: 'Clicca l\'elemento [n]. Il risultato riporta cosa è cambiato nella pagina (nuovi elementi, messaggi, navigazione).',
      en: 'Click element [n]. The result reports what changed on the page (new elements, messages, navigation).',
    },
  },
  {
    name: 'browser_fill_ref', tier: 'core', kind: 'action', mutating: true,
    schema: obj({ ref: REF, text: { type: 'string' }, submit: { type: 'boolean', description: 'Press Enter after filling' } }, ['ref', 'text']),
    toInput: json,
    description: {
      it: 'Compila il campo [n] con il testo (sostituisce il valore esistente; eventi nativi, ok con React/Vue). submit=true preme Invio dopo.',
      en: 'Fill field [n] with text (replaces the current value; native events, React/Vue safe). submit=true presses Enter afterwards.',
    },
  },
  {
    name: 'browser_select_ref', tier: 'core', kind: 'action', mutating: true,
    schema: obj({ ref: REF, option: { type: 'string', description: 'Visible option text (or value)' } }, ['ref', 'option']),
    toInput: json,
    description: {
      it: 'Seleziona un\'opzione nel menu a tendina [n], sia <select> nativo sia combobox personalizzata (apre il menu e clicca l\'opzione).',
      en: 'Select an option in dropdown [n], native <select> or custom combobox (opens it and clicks the option).',
    },
  },
  {
    name: 'browser_hover_ref', tier: 'core', kind: 'action', mutating: true,
    schema: obj({ ref: REF }, ['ref']), toInput: str('ref'),
    description: {
      it: 'Porta il mouse sopra l\'elemento [n] (menu che si aprono al passaggio del mouse).',
      en: 'Hover element [n] (menus that open on hover).',
    },
  },
  {
    name: 'browser_scroll', tier: 'core', kind: 'observation', family: 'page', mutating: true,
    schema: obj({
      direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] },
      ref: { type: 'integer', description: 'Scroll this element into view instead' },
    }),
    toInput: json,
    description: {
      it: 'Scorre la pagina (o il suo contenitore interno) e restituisce la nuova osservazione. Usalo quando l\'osservazione indica elementi SOTTO/SOPRA.',
      en: 'Scroll the page (or its inner container) and return the new observation. Use it when the observation reports elements BELOW/ABOVE.',
    },
  },
  {
    name: 'browser_press_key', tier: 'core', kind: 'action', mutating: true,
    schema: obj({ key: { type: 'string', description: 'e.g. Enter, Escape, Tab, ArrowDown, Control+A' } }, ['key']),
    toInput: str('key'),
    description: {
      it: 'Premi un tasto sull\'elemento con il focus (Enter, Escape, Tab, frecce, combinazioni come Control+A).',
      en: 'Press a key on the focused element (Enter, Escape, Tab, arrows, combos like Control+A).',
    },
  },
  {
    name: 'browser_navigate', tier: 'core', kind: 'action', family: 'page', mutating: true,
    schema: obj({ url: { type: 'string' } }, ['url']), toInput: str('url'),
    description: {
      it: 'Apri un URL nel tab attivo. Restituisce l\'osservazione della nuova pagina.',
      en: 'Open a URL in the active tab. Returns the observation of the new page.',
    },
  },
  {
    name: 'browser_navigate_back', tier: 'core', kind: 'action', family: 'page', mutating: true,
    schema: obj({}), toInput: () => '',
    description: { it: 'Torna alla pagina precedente.', en: 'Go back to the previous page.' },
  },
  {
    name: 'browser_read_text', tier: 'core', kind: 'observation', family: 'text',
    schema: obj({}), toInput: () => '',
    description: {
      it: 'Leggi tutto il testo visibile della pagina (contenuti, tabelle, dettagli). Per dati strutturati preferisci extract_with_schema.',
      en: 'Read all visible text of the page (content, tables, details). For structured data prefer extract_with_schema.',
    },
  },
  {
    name: 'browser_tab', tier: 'core', kind: 'action', family: 'tabs',
    schema: obj({
      action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
      index: { type: 'integer' },
      url: { type: 'string' },
    }, ['action']),
    toInput: json,
    description: {
      it: 'Gestisci i tab: list (elenco), new (apri, opzionale url), select (passa al tab index), close.',
      en: 'Manage tabs: list, new (optional url), select (switch to tab index), close.',
    },
  },
  {
    name: 'browser_wait', tier: 'core', kind: 'action',
    schema: obj({ seconds: { type: 'number', description: 'Fixed wait; omit to wait until the page stops changing' } }),
    toInput: json,
    description: {
      it: 'Attendi contenuti lenti: finché la pagina smette di cambiare, oppure N secondi.',
      en: 'Wait for slow content: until the page stops changing, or N seconds.',
    },
  },
  {
    name: 'browser_handle_dialog', tier: 'core', kind: 'action', mutating: true,
    schema: obj({ action: { type: 'string', enum: ['accept', 'dismiss'] }, text: { type: 'string' } }, ['action']),
    toInput: (a) => (a?.text ? `${a.action}|${a.text}` : String(a?.action ?? '')),
    description: {
      it: 'Accetta o annulla il dialog del browser aperto (alert/confirm/prompt). Lo stato segnala quando ce n\'è uno.',
      en: 'Accept or dismiss the open browser dialog (alert/confirm/prompt). The state reports when one is open.',
    },
  },
  {
    name: 'extract_with_schema', tier: 'core', kind: 'data',
    schema: obj({
      schema: { type: 'object', description: 'JSON Schema of the data to extract' },
      hint: { type: 'string' },
    }, ['schema']),
    toInput: json,
    description: {
      it: 'Estrai dati strutturati dalla pagina come JSON conforme allo schema (validato). Usalo per qualunque estrazione di dati.',
      en: 'Extract structured data from the page as JSON matching the schema (validated). Use it for any data extraction.',
    },
  },
  {
    name: 'paginate_and_collect', tier: 'core', kind: 'data', mutating: true,
    schema: obj({
      schema: { type: 'object' },
      nextButtonText: { type: 'string' },
      nextButtonSelector: { type: 'string' },
      maxPages: { type: 'integer' },
      deduplicateField: { type: 'string' },
    }, ['schema']),
    toInput: json,
    description: {
      it: 'Estrai dati su più pagine di una lista paginata (clicca "Avanti" e unisce i risultati).',
      en: 'Extract data across the pages of a paginated list (clicks "Next" and merges results).',
    },
  },
  {
    name: 'run_procedure', tier: 'core', kind: 'action', mutating: true,
    schema: obj({
      name: { type: 'string', description: 'Exact procedure name from the list provided at task start' },
      params: { type: 'object', additionalProperties: { type: 'string' } },
      startAt: { type: 'integer', description: 'Resume from this step number (1-based) after completing a step manually' },
    }, ['name']),
    toInput: json,
    description: {
      it: 'Esegui una procedura salvata (passi registrati e verificati, molto più veloce e affidabile). Se un passo fallisce ricevi il passo da completare a mano e poi riprendi con startAt.',
      en: 'Run a saved procedure (recorded, verified steps: much faster and more reliable). If a step fails you get the step to finish manually, then resume with startAt.',
    },
  },
  {
    name: 'update_plan', tier: 'core', kind: 'meta',
    schema: obj({
      steps: {
        type: 'array',
        items: obj({ title: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done'] } }, ['title', 'status']),
      },
    }, ['steps']),
    toInput: json,
    description: {
      it: 'Crea o aggiorna il piano del task (lista di passi con stato todo/doing/done). Il piano è mostrato nello stato a ogni turno: tienilo aggiornato nei task con più fasi.',
      en: 'Create or update the task plan (steps with status todo/doing/done). The plan is shown in the state every turn: keep it updated on multi-phase tasks.',
    },
  },
  // ── Vision ──────────────────────────────────────────────────────────────
  {
    name: 'browser_screenshot', tier: 'vision', kind: 'observation', family: 'image',
    schema: obj({ full: { type: 'boolean', description: 'Whole scrolling page' }, marks: { type: 'boolean', description: 'Draw element numbers' } }),
    toInput: (a) => [a?.full ? 'full' : '', a?.marks ? 'marks' : ''].filter(Boolean).join(','),
    description: {
      it: 'Screenshot della pagina (anche intera). Utile per grafici, immagini, layout. Per agire usa browser_observe.',
      en: 'Screenshot of the page (optionally full). Useful for charts, images, layout. To act, use browser_observe.',
    },
  },
  {
    name: 'browser_click_xy', tier: 'vision', kind: 'action', mutating: true,
    schema: obj({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']),
    toInput: json,
    description: {
      it: 'Clicca un punto dell\'ULTIMO screenshot (coordinate in pixel dell\'immagine). Solo per ciò che non ha un [numero] (canvas, mappe, grafici).',
      en: 'Click a point of the LAST screenshot (image pixel coordinates). Only for things without a [number] (canvas, maps, charts).',
    },
  },
];

/** Advanced tools: legacy single-string input, hidden unless enabled. */
const ADVANCED_NAMES: Array<[string, ToolKind, ObservationFamily?, boolean?]> = [
  ['browser_click', 'action', undefined, true],
  ['browser_type', 'action', undefined, true],
  ['browser_keyboard_type', 'action', undefined, true],
  ['browser_snapshot_dom', 'observation', 'dom'],
  ['browser_query', 'observation', 'dom'],
  ['browser_accessible_tree', 'observation', 'dom'],
  ['browser_interactive_map', 'observation', 'page'],
  ['browser_get_title', 'observation', 'tabs'],
  ['browser_get_active_tab', 'observation', 'tabs'],
  ['browser_wait_for_navigation', 'action'],
  ['browser_wait_for_stability', 'action'],
  ['browser_navigate_forward', 'action', 'page', true],
  ['browser_navigate_tab', 'action', undefined, true],
  ['browser_screenshot_tab', 'observation', 'image'],
  ['browser_move_mouse', 'action', undefined, true],
  ['browser_drag', 'action', undefined, true],
  ['browser_tab_list', 'observation', 'tabs'],
  ['browser_tab_new', 'action', 'tabs'],
  ['browser_tab_select', 'action', 'tabs'],
  ['browser_tab_close', 'action', 'tabs'],
  ['fill_form_from_data', 'action', undefined, true],
  ['smart_extract_data', 'data'],
  ['save_memory', 'meta'],
  ['lookup_memories', 'meta'],
  ['get_all_memories', 'meta'],
  ['delete_memory', 'meta'],
  ['clear_all_memories', 'meta'],
];

const ADVANCED: ToolSpec[] = ADVANCED_NAMES.map(([name, kind, family, mutating]) => ({
  name,
  tier: 'advanced',
  kind,
  family,
  mutating,
  schema: legacyInput,
  toInput: legacy,
  description: { it: TOOL_DESCRIPTIONS_IT[name] ?? name, en: TOOL_DESCRIPTIONS_EN[name] ?? name },
}));

const CATALOG = new Map<string, ToolSpec>([...CORE, ...ADVANCED].map(s => [s.name, s]));

export function getToolSpec(name: string): ToolSpec | undefined {
  return CATALOG.get(name);
}

export function allToolSpecs(): ToolSpec[] {
  return [...CATALOG.values()];
}

export interface ExposureOptions {
  vision: boolean;
  advanced: boolean;
}

/** Tools offered to the model, restricted to those actually registered. */
export function exposedToolSpecs(registered: Set<string>, opts: ExposureOptions): ToolSpec[] {
  return allToolSpecs().filter(s =>
    (registered.has(s.name) || s.name === 'update_plan') &&
    (s.tier === 'core' || (s.tier === 'vision' && opts.vision) || (s.tier === 'advanced' && opts.advanced))
  );
}

export function toolDescription(spec: ToolSpec, lang: Lang): string {
  return lang === 'en' ? spec.description.en : spec.description.it;
}

/**
 * Normalize a call coming from the model into (args object, legacy input
 * string). Native calls carry a JSON arguments string; XML calls carry free
 * text that may itself be JSON.
 */
export function normalizeCall(name: string, raw: string | Record<string, any>): { args: Record<string, any>; input: string } {
  const spec = getToolSpec(name);
  let args: Record<string, any> | null = null;
  if (typeof raw === 'object' && raw !== null) {
    args = raw;
  } else {
    const text = (raw ?? '').trim();
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
      } catch { /* not JSON */ }
    }
    if (!args) {
      // Free-text input (XML protocol / legacy tools)
      return { args: { input: text }, input: unwrapLegacy(spec, text) };
    }
  }
  if (!spec) return { args, input: typeof args.input === 'string' ? args.input : JSON.stringify(args) };
  // Native tools that kept the legacy wrapper ({input: "..."})
  if (spec.schema === legacyInput || (Object.keys(args).length === 1 && typeof args.input === 'string' && !('input' in (spec.schema as any).properties))) {
    return { args, input: String(args.input ?? '') };
  }
  return { args, input: spec.toInput(args) };
}

/** Free text for a core JSON tool: wrap the common single-value cases. */
function unwrapLegacy(spec: ToolSpec | undefined, text: string): string {
  if (!spec) return text;
  switch (spec.name) {
    case 'browser_navigate': return text;
    case 'browser_click_ref':
    case 'browser_hover_ref': return text;
    case 'browser_press_key': return text;
    case 'browser_tab': return JSON.stringify({ action: text || 'list' });
    default: return text;
  }
}

/** Stable signature of a call, for loop detection. */
export function callSignature(name: string, args: Record<string, any>): string {
  const sorted = (v: any): any => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc, k) => { acc[k] = sorted(v[k]); return acc; }, {} as Record<string, any>);
    }
    return v;
  };
  return `${name}:${JSON.stringify(sorted(args ?? {}))}`;
}
