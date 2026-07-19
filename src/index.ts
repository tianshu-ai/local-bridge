#!/usr/bin/env node
// @tianshu-ai/local-bridge — dial into a tianshu server and expose local
// tools (browser, …) to the agent via reverse-MCP.
//
// Usage:
//   npx @tianshu-ai/local-bridge --server wss://tianshu.example.com/ws --token ***
//   npx @tianshu-ai/local-bridge --server ws://localhost:3110/ws       (dev, no auth)
//
// Flags:
//   --server <url>     tianshu chat WS endpoint (required)
//   --token <token>    connection token from the Local Bridge panel
//   --device <id>      stable device id (default: hostname)
//   --label <name>     human label shown in the panel (default: device id)
//   --no-browser       don't expose browser tools (echo only)
//   --headless         run the browser without a window (default: headful)
//   --cdp <url>        connect to an already-running Chrome's CDP endpoint
//                      (default probe: http://127.0.0.1:9222). Set to "off"
//                      to skip and always launch.
//   --chrome-channel   which installed browser to launch: chrome (default),
//                      msedge, chrome-beta, … (never downloads Chromium)
//   --user-data-dir    reuse a Chrome profile dir so logins carry over

import os from "node:os";
import { BridgeConnection } from "./connection.js";
import { makeBrowserTools } from "./browser.js";
import { textResult, type LocalTool } from "./protocol.js";

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

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const server = typeof args.server === "string" ? args.server : "";
  if (!server) {
    console.error("error: --server <wss://host/ws> is required");
    console.error("example: npx @tianshu-ai/local-bridge --server wss://tianshu.example.com/ws --token ***");
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

  // Always ship a trivial echo tool so the round-trip can be verified
  // without a browser install.
  const echo: LocalTool = {
    descriptor: {
      name: "echo",
      description: "Echo the given text back (bridge connectivity check).",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    async run(a) {
      return textResult(String(a.text ?? ""));
    },
  };

  const browserOn = args["no-browser"] !== true;
  const tools: LocalTool[] = [echo];
  if (browserOn) {
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

  const conn = new BridgeConnection({
    server,
    token,
    deviceId,
    label,
    tools,
    log: (m) => console.log(`[local-bridge] ${m}`),
  });

  console.log(
    `[local-bridge] starting — device="${deviceId}", ${tools.length} tools, ` +
      `browser=${browserOn ? (cdpUrl ? `connect(${cdpUrl}) or ${channel}` : channel) : "off"}`,
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

main();
