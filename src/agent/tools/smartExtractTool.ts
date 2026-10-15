import type { Page } from "playwright-crx";
import { LLMProvider, ApiStream } from "../../models/providers/types";
import { stripThinkTags } from "../../models/providers/openai-compatible";
import { browserAccessibleTree, browserReadText } from "./observationTools";

async function consumeStream(stream: ApiStream): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.text) text += chunk.text;
  }
  return text;
}

function jsonToCsv(rows: any[]): string {
  if (!rows.length) return '';
  const keys = Array.from(new Set(rows.flatMap(r => (r && typeof r === 'object' ? Object.keys(r) : []))));
  if (!keys.length) return '';
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  return [keys.join(','), ...rows.map(r => keys.map(k => escape(r[k])).join(','))].join('\n');
}

export function smartExtract(page: Page, llmProvider: LLMProvider) {
  return {
    name: 'smart_extract_data',
    description:
      'Extracts structured data from the current page by reading visible text and the accessibility tree, then downloads the result as JSON or CSV. ' +
      'Input: JSON {hint?: string, format?: "json"|"csv"}.',
    func: async (input: string): Promise<string> => {
      try {
        if (!llmProvider) return 'Error: LLM provider not available';

        let params: any;
        try {
          params = JSON.parse(input);
        } catch {
          return 'Error: input must be valid JSON with {hint?, format?}';
        }

        const { hint = '', format = 'json' } = params;
        const targetFormat = format === 'csv' ? 'csv' : 'json';

        // 1. Capture both plain text and accessibility tree
        const readTextTool = browserReadText(page);
        const axTreeTool = browserAccessibleTree(page);

        const [pageText, axTree] = await Promise.all([
          readTextTool.func(''),
          axTreeTool.func('all'),
        ]);

        if (typeof pageText !== 'string' || typeof axTree !== 'string') {
          return 'Error: failed to read page content';
        }

        const combined = `=== VISIBLE TEXT ===\n${pageText}\n\n=== ACCESSIBILITY TREE ===\n${axTree}`;
        const maxChars = 200_000;
        const content = combined.length > maxChars ? combined.slice(0, maxChars) + '\n...[truncated]' : combined;

        // 2. Ask the LLM to infer a structure and return JSON
        const systemPrompt =
          'You are a structured data extractor. Analyze the provided page content and return ONLY valid JSON. ' +
          'The JSON must be an array of objects, where each object is one extracted record. ' +
          'Infer meaningful field names from the content. No explanations, no markdown code fences, just raw JSON.';
        const userMessage =
          `Extract structured data from the following page content.\n` +
          (hint ? `User hint: ${hint}\n` : '') +
          `Return the data as a JSON array of objects.\n\n${content}`;

        const messages = [{ role: 'user', content: userMessage }];
        const overrides = targetFormat === 'json' ? { response_format: { type: 'json_object' } } : undefined;
        const stream = llmProvider.createMessage(systemPrompt, messages, undefined, undefined, overrides);
        let raw = stripThinkTags(await consumeStream(stream)).trim();
        raw = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

        let data: any;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          return `Error: model did not return valid JSON. Raw output:\n${raw}`;
        }

        if (!Array.isArray(data)) {
          if (Array.isArray(data.items)) data = data.items;
          else data = [data];
        }

        // 3. Convert to requested format
        let fileContent: string;
        let mimeType: string;
        let extension: string;
        if (targetFormat === 'csv') {
          fileContent = jsonToCsv(data);
          mimeType = 'text/csv';
          extension = 'csv';
        } else {
          fileContent = JSON.stringify(data, null, 2);
          mimeType = 'application/json';
          extension = 'json';
        }

        // 4. Download
        const filename = `dommotion-extract-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
        const dataUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(fileContent)}`;
        try {
          await chrome.downloads.download({ url: dataUrl, filename });
        } catch (err) {
          return `Error downloading file: ${err instanceof Error ? err.message : String(err)}`;
        }

        return `Smart Extract completed. Downloaded ${filename} with ${data.length} record(s).`;
      } catch (err) {
        return `Error in smart_extract_data: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
