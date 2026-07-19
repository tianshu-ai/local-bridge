// Local browser tools, driven by Playwright against a real Chrome on the
// user's machine. Lazily launches on first use. Exposes a small, useful
// starter set; extend as needed.

import type { Browser, Page } from "playwright";
import { textResult, type LocalTool, type ToolResult } from "./protocol.js";

interface BrowserState {
  browser: Browser | null;
  page: Page | null;
}

async function ensurePage(state: BrowserState, headless: boolean): Promise<Page> {
  if (!state.browser) {
    const { chromium } = await import("playwright");
    state.browser = await chromium.launch({ headless });
  }
  if (!state.page || state.page.isClosed()) {
    state.page = await state.browser.newPage();
  }
  return state.page;
}

export function makeBrowserTools(opts: { headless: boolean }): LocalTool[] {
  const state: BrowserState = { browser: null, page: null };

  const navigate: LocalTool = {
    descriptor: {
      name: "browser_navigate",
      description: "Open a URL in the local browser and return the page title.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute URL to open." } },
        required: ["url"],
      },
    },
    async run(args): Promise<ToolResult> {
      const url = String(args.url ?? "");
      if (!/^https?:\/\//i.test(url)) return textResult("url must be an absolute http(s) URL", true);
      const page = await ensurePage(state, opts.headless);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const title = await page.title();
      return textResult(`Navigated to ${page.url()}\nTitle: ${title}`);
    },
  };

  const getText: LocalTool = {
    descriptor: {
      name: "browser_get_text",
      description: "Return the visible text of the current page (optionally a CSS selector).",
      inputSchema: {
        type: "object",
        properties: { selector: { type: "string", description: "Optional CSS selector; defaults to <body>." } },
      },
    },
    async run(args): Promise<ToolResult> {
      if (!state.page || state.page.isClosed()) return textResult("no page open — call browser_navigate first", true);
      const selector = typeof args.selector === "string" && args.selector ? args.selector : "body";
      const text = await state.page.locator(selector).first().innerText({ timeout: 15_000 }).catch(() => "");
      const clipped = text.slice(0, 8000);
      return textResult(clipped || "(no text found)");
    },
  };

  const click: LocalTool = {
    descriptor: {
      name: "browser_click",
      description: "Click the first element matching a CSS selector on the current page.",
      inputSchema: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
    },
    async run(args): Promise<ToolResult> {
      if (!state.page || state.page.isClosed()) return textResult("no page open — call browser_navigate first", true);
      const selector = String(args.selector ?? "");
      await state.page.locator(selector).first().click({ timeout: 15_000 });
      return textResult(`clicked ${selector}\nNow at: ${state.page.url()}`);
    },
  };

  const screenshot: LocalTool = {
    descriptor: {
      name: "browser_screenshot",
      description: "Capture a screenshot of the current page (returned as a note; saved locally).",
      inputSchema: { type: "object", properties: {} },
    },
    async run(): Promise<ToolResult> {
      if (!state.page || state.page.isClosed()) return textResult("no page open — call browser_navigate first", true);
      const path = `/tmp/tianshu-bridge-shot-${Date.now()}.png`;
      await state.page.screenshot({ path, fullPage: false });
      return textResult(`screenshot saved on the bridge host at ${path}`);
    },
  };

  return [navigate, getText, click, screenshot];
}
