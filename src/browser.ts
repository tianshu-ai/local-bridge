// Local browser tools, driven by Playwright against the user's OWN
// Chrome — never a bundled/downloaded Chromium.
//
// Acquisition strategy (best → fallback), so we reuse the real browser
// with its real fingerprint + logged-in cookies and avoid a heavy
// download:
//
//   1. CONNECT over CDP to a Chrome the user already has running with
//      `--remote-debugging-port` (default probe: http://127.0.0.1:9222).
//      This is the user's actual browser — real profile, real session.
//   2. LAUNCH the system-installed Google Chrome via Playwright's
//      `channel: "chrome"` (no Chromium download). Optionally reuse the
//      user's profile via `userDataDir` so logins carry over. Launched
//      with automation-detection softened.
//
// Nothing here downloads a browser; if neither path works the tool
// returns a clear, actionable error.

import type { Browser, BrowserContext, Page } from "playwright";
import { textResult, type LocalTool, type ToolResult } from "./protocol.js";

export interface BrowserConfig {
  /** CDP endpoint of an already-running Chrome. Empty string disables
   *  the connect path. Default: http://127.0.0.1:9222 */
  cdpUrl: string;
  /** Playwright browser channel to launch when connect fails.
   *  "chrome" = system Google Chrome (no download). Also "msedge",
   *  "chrome-beta", etc. */
  channel: string;
  /** Reuse this Chrome profile dir (persistent context) so logins carry
   *  over. Empty = ephemeral context. */
  userDataDir: string;
  /** Show the window. Launch path only (a connected Chrome keeps its
   *  own state). Default true — a real browser people can watch. */
  headful: boolean;
  log: (m: string) => void;
}

interface BrowserState {
  browser: Browser | null;
  context: BrowserContext | null;
  page: Page | null;
  how: string; // human description of how we got the browser
}

// Args that soften automation detection (navigator.webdriver etc.).
const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-default-browser-check",
  "--no-first-run",
];

async function probeCdp(cdpUrl: string): Promise<boolean> {
  if (!cdpUrl) return false;
  try {
    const base = cdpUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/json/version`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Acquire a Page, connecting to the user's Chrome or launching the
 *  system Chrome. Cached after first success. */
async function ensurePage(state: BrowserState, cfg: BrowserConfig): Promise<Page> {
  if (state.page && !state.page.isClosed()) return state.page;

  const { chromium } = await import("playwright");

  // 1) Connect to an already-running Chrome over CDP.
  if (!state.browser && !state.context && (await probeCdp(cfg.cdpUrl))) {
    try {
      const browser = await chromium.connectOverCDP(cfg.cdpUrl);
      state.browser = browser;
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      state.context = ctx;
      state.page = ctx.pages()[0] ?? (await ctx.newPage());
      state.how = `connected to your running Chrome at ${cfg.cdpUrl}`;
      cfg.log(state.how);
      return state.page;
    } catch (err) {
      cfg.log(`CDP connect failed (${err instanceof Error ? err.message : String(err)}); falling back to launch`);
    }
  }

  // 2) Launch the system-installed Chrome (no Chromium download).
  if (cfg.userDataDir) {
    // Persistent context reuses the user's profile → logged-in sessions.
    const ctx = await chromium.launchPersistentContext(cfg.userDataDir, {
      channel: cfg.channel,
      headless: !cfg.headful,
      args: STEALTH_ARGS,
    });
    state.context = ctx;
    state.page = ctx.pages()[0] ?? (await ctx.newPage());
    state.how = `launched system ${cfg.channel} with your profile (${cfg.userDataDir})`;
  } else {
    const browser = await chromium.launch({
      channel: cfg.channel,
      headless: !cfg.headful,
      args: STEALTH_ARGS,
    });
    state.browser = browser;
    state.context = await browser.newContext();
    state.page = await state.context.newPage();
    state.how = `launched system ${cfg.channel} (ephemeral profile)`;
  }
  cfg.log(state.how);
  return state.page;
}

export function makeBrowserTools(cfg: BrowserConfig): LocalTool[] {
  const state: BrowserState = { browser: null, context: null, page: null, how: "" };

  const navigate: LocalTool = {
    descriptor: {
      name: "browser_navigate",
      description:
        "Open a URL in the user's local browser and return the page title. Uses their real Chrome (real cookies/session).",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "Absolute http(s) URL to open." } },
        required: ["url"],
      },
    },
    async run(args): Promise<ToolResult> {
      const url = String(args.url ?? "");
      if (!/^https?:\/\//i.test(url)) return textResult("url must be an absolute http(s) URL", true);
      const page = await ensurePage(state, cfg);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const title = await page.title();
      return textResult(`Navigated to ${page.url()}\nTitle: ${title}\n(${state.how})`);
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
      return textResult(text.slice(0, 8000) || "(no text found)");
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
      description:
        "Capture a screenshot of the current page. The image travels back to the server and is saved to your workspace; the tool returns its path (call bridge_view_image to look at it).",
      inputSchema: {
        type: "object",
        properties: { fullPage: { type: "boolean", description: "Capture the full scrollable page (default false)." } },
      },
    },
    async run(args): Promise<ToolResult> {
      if (!state.page || state.page.isClosed()) return textResult("no page open — call browser_navigate first", true);
      const buf = await state.page.screenshot({ fullPage: args.fullPage === true, type: "png" });
      // Return the bytes as an MCP image block so the server can save
      // them under the user's workspace. Bytes do NOT enter the agent
      // context by default — the server stores + surfaces only a path.
      return {
        content: [
          { type: "text", text: `screenshot of ${state.page.url()}` },
          { type: "image", data: buf.toString("base64"), mimeType: "image/png" },
        ],
      };
    },
  };

  return [navigate, getText, click, screenshot];
}
