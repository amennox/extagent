import fs from 'fs';
import path from 'path';
import { chromium, Browser, Page } from 'playwright-core';

export const FIXTURES = path.resolve(__dirname, 'fixtures');

export function fixtureUrl(name: string): string {
  return 'file://' + path.join(FIXTURES, name);
}

/** True when a Playwright Chromium build is available (local dev / CI with browsers installed). */
export function chromiumAvailable(): boolean {
  try {
    const exe = chromium.executablePath();
    return !!exe && fs.existsSync(exe);
  } catch {
    return false;
  }
}

export async function launch(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export async function openFixture(browser: Browser, name: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.goto(fixtureUrl(name));
  return page;
}

export const describeIfChromium = chromiumAvailable() ? describe : describe.skip;
