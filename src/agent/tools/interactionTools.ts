import type { Page } from "playwright-crx";
import { ActionLog } from "../../tracking/actionLog";
import { settleAfterAction } from "./stability";
import { ToolFactory } from "./types";
import { installDialogListener, lastDialog, resetDialog, withActivePage } from "./utils";

export const browserClick: ToolFactory = (page: Page) =>
  ({
    name: "browser_click",
    description:
      "Click an element. Input may be a CSS selector or literal text to match on the page.",
    func: async (input: string) => {
      try {
        return await withActivePage(page, async (activePage) => {
          let detail: string;
          if (/[#.[]/.test(input)) {
            await activePage.click(input);
            ActionLog.push({ type: 'click', selector: input, candidates: [input], description: `click ${input}` });
            detail = `Clicked selector: ${input}`;
          } else {
            await activePage.getByText(input).click();
            ActionLog.push({ type: 'click', selector: `text=${input}`, candidates: [`text=${input}`], elementText: input, description: `click "${input}"` });
            detail = `Clicked element containing text: ${input}`;
          }
          // SPA-aware settle: wait for the render triggered by the click
          const settle = await settleAfterAction(activePage);
          return `${detail} · ${settle}`;
        });
      } catch (error) {
        return `Error clicking '${input}': ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    },
  });

export const browserType: ToolFactory = (page: Page) =>
  ({
    name: "browser_type",
    description:
      "Type text. Format: selector|text (e.g. input[name=\"q\"]|hello)",
    func: async (input: string) => {
      try {
        return await withActivePage(page, async (activePage) => {
          const sepIndex = input.indexOf("|");
          const selector = sepIndex >= 0 ? input.slice(0, sepIndex) : '';
          const text = sepIndex >= 0 ? input.slice(sepIndex + 1) : '';
          if (!selector || !text) {
            return "Error: expected 'selector|text'";
          }
          await activePage.fill(selector, text);
          ActionLog.push({ type: 'type', selector, candidates: [selector], text, description: `type in ${selector}` });
          const settle = await settleAfterAction(activePage);
          return `Typed "${text}" into ${selector} · ${settle}`;
        });
      } catch (error) {
        return `Error typing into '${input}': ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    },
  });

export const browserHandleDialog: ToolFactory = (page: Page) => {
  // Install dialog listener with the active page
  installDialogListener(page);

  return ({
    name: "browser_handle_dialog",
    description:
      "Accept or dismiss the most recent alert/confirm/prompt dialog.\n" +
      "Input `accept` or `dismiss`. For prompt dialogs you may append `|text` to supply response text.",
    func: async (input: string) => {
      try {
        if (!lastDialog)
          return "Error: no dialog is currently open or was detected.";
        const [action, text] = input.split("|").map(s => s.trim().toLowerCase());
        if (action !== "accept" && action !== "dismiss")
          return "Error: first part must be `accept` or `dismiss`.";
        if (action === "accept")
          await lastDialog.accept(text || undefined);
        else await lastDialog.dismiss();
        const type = lastDialog.type();
        resetDialog();
        return `${action === "accept" ? "Accepted" : "Dismissed"} ${type} dialog.`;
      } catch (err) {
        return `Error handling dialog: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    },
  });
};
