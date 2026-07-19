#!/usr/bin/env node
// @tianshu-ai/local-bridge — dial into a tianshu server and expose local
// tools (browser, …) to the agent via reverse-MCP.
//
// Install globally, then run `tsbridge`:
//   npm i -g @tianshu-ai/local-bridge
//   tsbridge --server wss://tianshu.example.com/ws --token ***
// Or one-off via npx:
//   npx @tianshu-ai/local-bridge --server ws://localhost:3110/ws       (dev, no auth)
//
// Flags:
//   --server <url>     tianshu chat WS endpoint (required)
//   --token <token>    connection token from the Local Bridge panel
//   --device <id>      stable device id (default: hostname)
//   --label <name>     human label shown in the panel (default: device id)
//   --no-browser         don't expose browser tools
//   --browser-engine     own | stealth (default: own)
//                          own     = your system/running Chrome (no download,
//                                    real cookies+fingerprint)
//                          stealth = cloakbrowser-mcp (CloakBrowser stealth
//                                    Chromium, full Playwright-MCP toolset,
//                                    passes bot detection; ~200MB first run)
//   --headless           run the browser without a window (own + stealth;
//                          default is headful — a window you can watch)
//   --cdp <url>          own: connect to a running Chrome's CDP endpoint
//                        (default probe http://127.0.0.1:9222; "off" to skip)
//   --chrome-channel     own: which installed browser to launch (chrome, msedge, …)
//   --user-data-dir      own: reuse a Chrome profile dir so logins carry over

import os from "node:os";
import { BridgeConnection } from "./connection.js";
import { makeBrowserTools } from "./browser.js";
import { connectMcpChild } from "./mcp-child.js";
import { runUpdate, installedVersion } from "./update.js";
import type { LocalTool } from "./protocol.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function main(): Promise<void> {
  // First positional (not starting with --) selects a subcommand.
  const argv = process.argv.slice(2);
  const sub = argv.find((a) => !a.startsWith("--"));
  const args = parseArgs(argv);

  if (sub === "update") {
    process.exit(
      await runUpdate({
        check: args.check === true,
        dryRun: args["dry-run"] === true,
        tag: typeof args.tag === "string" ? args.tag : undefined,
      }),
    );
  }
  if (sub === "version" || args.version === true || args.v === true) {
    process.stdout.write(`@tianshu-ai/local-bridge v${installedVersion()}\n`);
    process.exit(0);
  }

  const server = typeof args.server === "string" ? args.server : "";
  if (!server) {
    console.error("error: --server <wss://host/ws> is required");
    console.error("example: tsbridge --server wss://tianshu.example.com/ws --token ***");
    console.error("install:  npm i -g @tianshu-ai/local-bridge   (then run `tsbridge`)");
    console.error("commands: tsbridge update [--check|--dry-run|--tag <t>]   |   tsbridge version");
    process.exit(2);
  }
  const token = typeof args.token === "string" ? args.token : undefined;
  const deviceId = (typeof args.device === "string" && args.device) || os.hostname() || "bridge";
  const label = typeof args.label === "string" ? args.label : deviceId;
  // Default headful: a real browser window the user can watch. --headless to hide.
  const headful = args.headless !== true;
  const cdpArg = typeof args.cdp === "string" ? args.cdp : "http://127.0.0.1:9222";
  const cdpUrl = cdpArg === "off" ? "" : cdpArg;
  const channel = typeof args["chrome-channel"] === "string" ? (args["chrome-channel"] as string) : "chrome";
  const userDataDir = typeof args["user-data-dir"] === "string" ? (args["user-data-dir"] as string) : "";

  const browserOn = args["no-browser"] !== true;
  const engine = args["browser-engine"] === "stealth" ? "stealth" : "own";
  const tools: LocalTool[] = [];
  if (browserOn) {
    if (engine === "stealth") {
      // Full Playwright-MCP toolset pointed at CloakBrowser stealth
      // Chromium. Spawned as a child MCP server over stdio.
      try {
        // cloakbrowser-mcp reads PLAYWRIGHT_MCP_HEADLESS (default true =
        // headless). Set it explicitly from our headful/--headless flag
        // so the window shows when the user wants it.
        const stealthTools = await connectMcpChild({
          command: "npx",
          args: ["-y", "cloakbrowser-mcp@latest"],
          env: { PLAYWRIGHT_MCP_HEADLESS: headful ? "false" : "true" },
          log: (m) => console.log(`[local-bridge] ${m}`),
        });
        tools.push(...stealthTools);
      } catch (err) {
        console.error(
          `[local-bridge] failed to start stealth browser (cloakbrowser-mcp): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        process.exit(1);
      }
    } else {
      tools.push(
        ...makeBrowserTools({
          cdpUrl,
          channel,
          userDataDir,
          headful,
          log: (m) => console.log(`[local-bridge] ${m}`),
        }),
      );
    }
  }

  if (tools.length === 0) {
    console.error(
      "[local-bridge] no tools enabled — nothing to expose. Remove --no-browser (or enable a capability) and try again.",
    );
    process.exit(2);
  }

  const conn = new BridgeConnection({
    server,
    token,
    deviceId,
    label,
    tools,
    log: (m) => console.log(`[local-bridge] ${m}`),
  });

  const browserDesc = !browserOn
    ? "off"
    : engine === "stealth"
      ? "stealth (cloakbrowser)"
      : cdpUrl
        ? `own: connect(${cdpUrl}) or ${channel}`
        : `own: ${channel}`;
  console.log(
    `[local-bridge] starting — device="${deviceId}", ${tools.length} tools, browser=${browserDesc}`,
  );
  conn.start();

  const shutdown = () => {
    console.log("\n[local-bridge] shutting down…");
    conn.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[local-bridge] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
