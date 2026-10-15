import type { Page } from "playwright-crx";
import { afterRefAction, getCurrentMap, observePage } from "./pageMapTools";
import { getLastScreenshotScale } from "./screenshot";
import { waitForPageStability } from "./stability";
import { browserTabClose, browserTabList, browserTabNew, browserTabSelect } from "./tabTools";
import { ToolOutput } from "./types";
import { withActivePage } from "./utils";

/**
 * Compact core tools exposed to the model (one tool per concept, JSON args).
 * They wrap the legacy single-purpose tools.
 */

function parse(input: string): Record<string, any> {
  try {
    const v = JSON.parse(input || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function browserTab(page: Page) {
  const list = browserTabList(page);
  const create = browserTabNew(page);
  const select = browserTabSelect(page);
  const close = browserTabClose(page);
  return {
    name: 'browser_tab',
    description: 'Manage tabs. Input: JSON {action: "list"|"new"|"select"|"close", index?, url?}.',
    func: async (input: string): Promise<string | ToolOutput> => {
      const args = parse(input);
      const action = String(args.action ?? (input?.trim() || 'list')).toLowerCase();
      switch (action) {
        case 'list': return list.func('');
        case 'new': {
          const opened = await create.func(String(args.url ?? ''));
          return `${opened}\nTip: call browser_tab with {"action":"select"} to work in it.`;
        }
        case 'select': {
          const res = await select.func(String(args.index ?? ''));
          if (String(res).startsWith('Error')) return res;
          return withActivePage(page, async (active) => {
            const obs = await observePage(active).catch(() => null);
            return obs ? { ...obs, text: `${res}\n${obs.text}` } : res;
          });
        }
        case 'close': return close.func(args.index === undefined ? '' : String(args.index));
        default: return `Error: unknown tab action "${action}" (use list|new|select|close).`;
      }
    },
  };
}

export function browserWait(page: Page) {
  return {
    name: 'browser_wait',
    description: 'Wait for slow content: until the page stops changing, or a fixed number of seconds. Input: JSON {seconds?}.',
    func: async (input: string): Promise<string> => {
      const args = parse(input);
      const seconds = Number(args.seconds ?? (parseFloat(input) || 0));
      return withActivePage(page, async (active) => {
        if (seconds > 0) {
          await active.waitForTimeout(Math.min(seconds, 30) * 1000);
          return `Waited ${Math.min(seconds, 30)}s.`;
        }
        return `Page ${await waitForPageStability(active, 600, 10000)}`;
      });
    },
  };
}

/** Vision-only: click at a point of the last screenshot (canvas, maps, charts). */
export function browserClickPoint(page: Page) {
  return {
    name: 'browser_click_xy',
    description: 'Click at a point of the LAST screenshot (pixel coordinates of the image). Use only for things without a [number] (canvas, maps, charts). Input: JSON {x, y}.',
    func: async (input: string): Promise<string> => {
      const args = parse(input);
      let x = Number(args.x);
      let y = Number(args.y);
      if (args.x === undefined && /[|,]/.test(input)) {
        const [a, b] = input.split(/[|,]/).map(s => Number(s.trim()));
        x = a; y = b;
      }
      if (Number.isNaN(x) || Number.isNaN(y)) return 'Error: expected {"x": number, "y": number}.';
      const scale = getLastScreenshotScale();
      const cx = Math.round(x * scale);
      const cy = Math.round(y * scale);
      return withActivePage(page, async (active) => {
        await active.mouse.click(cx, cy);
        if (!getCurrentMap()) return `Clicked at (${cx}, ${cy}) CSS px.`;
        return afterRefAction(active, `Clicked at (${cx}, ${cy}) CSS px`);
      });
    },
  };
}
