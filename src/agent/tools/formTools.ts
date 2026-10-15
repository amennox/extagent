import type { Page } from "playwright-crx";
import { ToolFactory } from "./types";
import { withActivePage } from "./utils";

export interface FieldInfo {
  tagName: string;
  type: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
  selector: string;
}

export interface MatchResult {
  field: string;
  fieldName: string;
  value: unknown;
  matched_by: 'id' | 'name' | 'label' | 'proximity';
}

export interface MatchOutput {
  compiled: MatchResult[];
  unmatched: string[];
}

function normalize(str: string): string {
  return str.toLowerCase().trim().replace(/[\s\-_]+/g, '');
}

/**
 * Match a data payload to scanned form fields using a priority chain:
 * id → name → label (exact) → label (contains / proximity).
 * Hidden fields are always skipped.
 */
export function matchFields(
  data: Record<string, unknown>,
  fields: FieldInfo[]
): MatchOutput {
  const compiled: MatchResult[] = [];
  const unmatched: string[] = [];
  const used = new Set<string>();

  for (const [key, value] of Object.entries(data)) {
    const normKey = normalize(key);
    let matched: MatchResult | null = null;

    const visible = fields.filter(f => f.type !== 'hidden' && !used.has(f.selector));

    // a. Exact id match
    for (const f of visible) {
      if (f.id && normalize(f.id) === normKey) {
        matched = { field: f.selector, fieldName: f.id, value, matched_by: 'id' };
        break;
      }
    }

    // b. Exact name match
    if (!matched) {
      for (const f of visible) {
        if (f.name && normalize(f.name) === normKey) {
          matched = { field: f.selector, fieldName: f.name, value, matched_by: 'name' };
          break;
        }
      }
    }

    // c. Normalised label / placeholder exact match
    if (!matched) {
      for (const f of visible) {
        const normLabel = normalize(f.label || f.placeholder || '');
        if (normLabel && normLabel === normKey) {
          matched = { field: f.selector, fieldName: f.label || f.placeholder, value, matched_by: 'label' };
          break;
        }
      }
    }

    // d. Proximity: label contains key or key contains label
    if (!matched) {
      for (const f of visible) {
        const normLabel = normalize(f.label || f.placeholder || '');
        if (normLabel && (normLabel.includes(normKey) || normKey.includes(normLabel))) {
          matched = { field: f.selector, fieldName: f.label || f.placeholder, value, matched_by: 'proximity' };
          break;
        }
      }
    }

    if (matched) {
      compiled.push(matched);
      used.add(matched.field);
    } else {
      unmatched.push(key);
    }
  }

  return { compiled, unmatched };
}

/**
 * Scan all visible form fields on the active page.
 * Returns field metadata including a reliable CSS selector for each field.
 */
export async function scanFormFields(page: Page): Promise<FieldInfo[]> {
  return withActivePage(page, async (activePage) => {
    return activePage.$$eval(
      'input:not([type=hidden]), textarea, select',
      (elements: Element[]) => {
        return elements.map(el => {
          const tagName = el.tagName.toLowerCase();
          const type = (el as HTMLInputElement).type || tagName;
          const name = (el as HTMLInputElement).name || '';
          const id = el.id || '';
          const placeholder = (el as HTMLInputElement).placeholder || '';

          // Resolve associated label text
          let label = '';
          if (id) {
            const labelEl = document.querySelector(`label[for="${id}"]`);
            if (labelEl) label = labelEl.textContent?.trim() || '';
          }
          if (!label) {
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) label = ariaLabel.trim();
          }
          if (!label) {
            const labelledById = el.getAttribute('aria-labelledby');
            if (labelledById) {
              const refEl = document.getElementById(labelledById);
              if (refEl) label = refEl.textContent?.trim() || '';
            }
          }

          // Build a reliable selector
          let selector = '';
          if (id) {
            selector = `#${id}`;
          } else if (name) {
            selector = `${tagName}[name="${name}"]`;
          } else {
            selector = tagName;
          }

          return { tagName, type, name, id, label, placeholder, selector };
        });
      }
    ) as Promise<FieldInfo[]>;
  });
}

export const fillFormFromData: ToolFactory = (page: Page) => ({
  name: 'fill_form_from_data',
  description: 'Compila i campi di un form da un payload strutturato. Non fa submit. Input: JSON {data: {campo: valore}, submitSelector?}.',
  func: async (input: string): Promise<string> => {
    try {
      let params: any;
      try {
        params = JSON.parse(input);
      } catch {
        return 'Error: input must be valid JSON with {data, submitSelector?}';
      }

      const { data } = params;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return 'Error: data must be an object mapping field names to values';
      }

      // 1. Scan available fields
      let fields: FieldInfo[];
      try {
        fields = await scanFormFields(page);
      } catch (err) {
        return `Error scanning form fields: ${err instanceof Error ? err.message : String(err)}`;
      }

      // 2. Match data to fields
      const { compiled, unmatched } = matchFields(data as Record<string, unknown>, fields);

      // 3. Fill matched fields
      for (const match of compiled) {
        try {
          await withActivePage(page, async (activePage) => {
            const fieldInfo = fields.find(f => f.selector === match.field);
            const type = fieldInfo?.type || 'text';
            const val = match.value;

            if (type === 'checkbox') {
              if (val) {
                await activePage.check(match.field);
              } else {
                await activePage.uncheck(match.field);
              }
            } else if (type === 'radio') {
              if (val) await activePage.check(match.field);
            } else if (fieldInfo?.tagName === 'select') {
              await activePage.selectOption(match.field, String(val));
            } else {
              await activePage.fill(match.field, String(val));
            }
          });
        } catch {
          // Continue with remaining fields even if one fails
        }
      }

      const readyForSubmit = compiled.length > 0;

      return JSON.stringify({
        compiled: compiled.map(m => ({ field: m.fieldName, value: m.value, matched_by: m.matched_by })),
        unmatched,
        readyForSubmit,
      });
    } catch (err) {
      return `Error in fill_form_from_data: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
