import type { Page } from "playwright-crx";
import { settleAfterAction } from "./stability";
import { ToolFactory } from "./types";
import { withActivePage } from "./utils";

export const browserPressKey: ToolFactory = (page: Page) =>
  ({
    name: "browser_press_key",
    description:
      "Press a single key. Input is the key name (e.g. `Enter`, `ArrowLeft`, `a`).",
    func: async (key: string) => {
      try {
        return await withActivePage(page, async (activePage) => {
          if (!key.trim()) return "Error: key name required";
          await activePage.keyboard.press(key.trim());
          // Enter often triggers submit/render on SPAs — wait for settle
          if (/^enter$/i.test(key.trim())) {
            const settle = await settleAfterAction(activePage);
            return `Pressed key: ${key.trim()} · ${settle}`;
          }
          return `Pressed key: ${key.trim()}`;
        });
      } catch (err) {
        return `Error pressing key '${key}': ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  });

export const browserKeyboardType: ToolFactory = (page: Page) =>
  ({
    name: "browser_keyboard_type",
    description:
      "Type arbitrary text at the current focus location. Input is the literal text to type. Use `\\n` for new lines.",
    func: async (text: string) => {
      try {
        return await withActivePage(page, async (activePage) => {
          await activePage.keyboard.type(text);
          return `Typed ${text.length} characters`;
        });
      } catch (err) {
        return `Error typing text: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  });
