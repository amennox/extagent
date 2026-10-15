import Ajv from 'ajv';
import type { Page } from "playwright-crx";
import TurndownService from 'turndown';
import { LLMProvider, ApiStream } from "../../models/providers/types";
import { withActivePage } from "./utils";

const KEEP_ARIA_ATTRS = new Set(['aria-label', 'aria-labelledby', 'role']);

/**
 * Convert an HTML string to readable markdown.
 * Removes script/style/noscript tags, aria-hidden elements, and noisy attributes.
 */
export function preprocessDOM(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove noise tags
  doc.querySelectorAll('script, style, noscript').forEach(el => el.remove());

  // Remove hidden elements
  doc.querySelectorAll('[aria-hidden="true"]').forEach(el => el.remove());

  // Strip noisy attributes from all elements
  doc.body.querySelectorAll('*').forEach(el => {
    const toRemove: string[] = [];
    for (const attr of Array.from(el.attributes)) {
      if (
        attr.name.startsWith('data-') ||
        (attr.name.startsWith('aria-') && !KEEP_ARIA_ATTRS.has(attr.name))
      ) {
        toRemove.push(attr.name);
      }
    }
    toRemove.forEach(name => el.removeAttribute(name));
  });

  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
  return td.turndown(doc.body.innerHTML);
}

async function consumeStream(stream: ApiStream): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.text) text += chunk.text;
  }
  return text;
}

export function extractWithSchema(page: Page, llmProvider: LLMProvider) {
  return {
    name: 'extract_with_schema',
    description: 'Estrae dati strutturati dalla pagina come JSON conforme allo schema. Input: JSON {schema, hint?, useAccessibilityTree?}.',
    func: async (input: string): Promise<string> => {
      try {
        if (!llmProvider) return 'Error: LLM provider not available';

        let params: any;
        try {
          params = JSON.parse(input);
        } catch {
          return 'Error: input must be valid JSON with {schema, hint?, useAccessibilityTree?}';
        }

        const { schema, hint, useAccessibilityTree = true } = params;
        if (!schema) return 'Error: schema is required';

        // Get page content
        let content: string;
        try {
          content = await withActivePage(page, async (activePage) => {
            if (useAccessibilityTree) {
              const tree = await activePage.accessibility.snapshot({ interestingOnly: true });
              return JSON.stringify(tree, null, 2);
            } else {
              const html = await activePage.content();
              return preprocessDOM(html);
            }
          });
        } catch (err) {
          return `Error reading page content: ${err instanceof Error ? err.message : String(err)}`;
        }

        const systemPrompt =
          'You are a structured data extractor. Return ONLY valid JSON conforming exactly to the provided schema. No explanations, no markdown code blocks, just the raw JSON.';
        const userMessage =
          `Extract data from the following content and return ONLY a JSON object conforming to this JSON Schema:\n${JSON.stringify(schema, null, 2)}` +
          (hint ? `\n\nHint: ${hint}` : '') +
          `\n\nContent:\n${content}`;

        type Msg = { role: string; content: string };
        const messages: Msg[] = [{ role: 'user', content: userMessage }];

        const ajv = new Ajv({ allErrors: true });
        let validate: ReturnType<typeof ajv.compile> | null = null;
        try {
          validate = ajv.compile(schema);
        } catch {
          // Schema too complex for AJV in this environment — proceed with JSON-only validation
        }

        let lastResult = '';
        let lastError = '';

        for (let attempt = 0; attempt <= 2; attempt++) {
          if (attempt > 0) {
            messages.push({ role: 'assistant', content: lastResult });
            messages.push({ role: 'user', content: `The JSON you returned is not valid: ${lastError}. Return ONLY the corrected JSON, no explanations.` });
          }

          // First attempt uses the standard response_format JSON mode (fewer
          // AJV retries when the endpoint supports it); retries fall back to
          // prompt-forced JSON for endpoints that reject the parameter.
          const overrides = attempt === 0
            ? { response_format: { type: 'json_object' } }
            : undefined;
          const stream = llmProvider.createMessage(systemPrompt, messages, [], undefined, overrides);
          const raw = (await consumeStream(stream)).trim();

          // Strip markdown code fence if model wrapped the output
          lastResult = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

          let parsed: unknown;
          try {
            parsed = JSON.parse(lastResult);
          } catch (e) {
            lastError = `JSON parse error: ${e instanceof Error ? e.message : String(e)}`;
            continue;
          }

          // If AJV compiled successfully, validate against schema; otherwise accept any valid JSON
          if (validate) {
            try {
              if (validate(parsed)) return JSON.stringify(parsed);
              lastError = ajv.errorsText(validate.errors);
              lastResult = JSON.stringify(parsed);
            } catch {
              // Validation threw unexpectedly — accept the parsed JSON
              return JSON.stringify(parsed);
            }
          } else {
            return JSON.stringify(parsed);
          }
        }

        return `Error: extraction failed after 3 attempts. Last error: ${lastError}`;
      } catch (err) {
        return `Error in extract_with_schema: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  };
}

export function paginateAndCollect(page: Page, llmProvider: LLMProvider) {
  return {
    name: 'paginate_and_collect',
    description: 'Raccoglie dati su più pagine con extract_with_schema. Input: JSON {schema, nextButtonSelector?, nextButtonText?, maxPages?, deduplicateField?}.',
    func: async (input: string): Promise<string> => {
      try {
        if (!llmProvider) return 'Error: LLM provider not available';

        let params: any;
        try {
          params = JSON.parse(input);
        } catch {
          return 'Error: input must be valid JSON with {schema, nextButtonSelector?, nextButtonText?, maxPages?, deduplicateField?}';
        }

        const { schema, nextButtonSelector, nextButtonText, maxPages = 10, deduplicateField } = params;
        if (!schema) return 'Error: schema is required';

        const extractor = extractWithSchema(page, llmProvider);
        const allItems: object[] = [];
        const seenKeys = new Set<string>();
        let pagesVisited = 0;
        let truncated = false;

        for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
          const extractResult = await extractor.func(JSON.stringify({ schema }));

          if (extractResult.startsWith('Error:')) break;

          let pageData: any;
          try {
            pageData = JSON.parse(extractResult);
          } catch {
            break;
          }

          const items: object[] = Array.isArray(pageData)
            ? pageData
            : Array.isArray(pageData?.items)
              ? pageData.items
              : [pageData];

          const prevCount = allItems.length;

          for (const item of items) {
            if (deduplicateField) {
              const key = String((item as any)[deduplicateField] ?? '');
              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                allItems.push(item);
              }
            } else {
              allItems.push(item);
            }
          }

          pagesVisited++;

          // Stop if no new items (same data returned or empty page)
          if (allItems.length === prevCount && pageIndex > 0) break;

          // Last allowed page — mark as truncated and stop
          if (pageIndex === maxPages - 1) {
            truncated = true;
            break;
          }

          // Try to navigate to the next page
          const clicked = await withActivePage(page, async (activePage) => {
            try {
              if (nextButtonSelector) {
                const el = await activePage.$(nextButtonSelector);
                if (!el) return false;
                const disabled = await el.getAttribute('disabled');
                if (disabled !== null) return false;
                await el.click();
                await activePage.waitForTimeout(1000);
                return true;
              } else if (nextButtonText) {
                await activePage.getByText(nextButtonText, { exact: false }).click();
                await activePage.waitForTimeout(1000);
                return true;
              }
              return false;
            } catch {
              return false;
            }
          });

          if (!clicked) break;
        }

        return JSON.stringify({ items: allItems, pagesVisited, truncated });
      } catch (err) {
        return `Error in paginate_and_collect: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  };
}
