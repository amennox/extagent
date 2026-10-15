import type { Page } from "playwright-crx";
import { BrowserTool } from "./tools/types";

/**
 * ToolManager: registry of the tool implementations available to the agent.
 * (Connection-loss handling lives in the engine: one place, no extra CDP
 * round-trip before every tool call.)
 */
export class ToolManager {
  private page: Page;
  private tools: BrowserTool[];
  private byName: Map<string, BrowserTool>;

  constructor(page: Page, tools: BrowserTool[]) {
    this.page = page;
    this.tools = tools;
    this.byName = new Map(tools.map(t => [t.name, t]));
  }

  getTools(): BrowserTool[] {
    return this.tools;
  }

  getPage(): Page {
    return this.page;
  }

  findTool(toolName: string): BrowserTool | undefined {
    return this.byName.get(toolName);
  }

  async isConnectionHealthy(): Promise<boolean> {
    try {
      await this.page.evaluate(() => true);
      return true;
    } catch {
      return false;
    }
  }
}
