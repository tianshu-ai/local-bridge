#!/usr/bin/env node
// tianshu-bridge — dial into a tianshu server and expose local tools
// (browser, …) to the agent via reverse-MCP.
//
// Usage:
//   tianshu-bridge --server wss://tianshu.example.com/ws --token ***
//   tianshu-bridge --server ws://localhost:3110/ws            (dev, no auth)
//
// Flags:
//   --server <url>     tianshu chat WS endpoint (required)
//   --token <token>    connection token from the Local Bridge panel
//   --device <id>      stable device id (default: hostname)
//   --label <name>     human label shown in the panel (default: device id)
//   --headful          show the browser window (default: headless)
//   --no-browser       don't expose browser tools (echo only)

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
    console.error("example: tianshu-bridge --server wss://tianshu.example.com/ws --token ***");
    process.exit(2);
  }
  const token = typeof args.token === "string" ? args.token : undefined;
  const deviceId = (typeof args.device === "string" && args.device) || os.hostname() || "bridge";
  const label = typeof args.label === "string" ? args.label : deviceId;
  const headless = args.headful !== true;

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

  const tools: LocalTool[] = [echo];
  if (args.browser !== false && args["no-browser"] !== true) {
    tools.push(...makeBrowserTools({ headless }));
  }

  const conn = new BridgeConnection({
    server,
    token,
    deviceId,
    label,
    tools,
    log: (m) => console.log(`[tianshu-bridge] ${m}`),
  });

  console.log(
    `[tianshu-bridge] starting — device="${deviceId}", ${tools.length} tools, ` +
      `browser=${args.browser !== false && args["no-browser"] !== true ? (headless ? "headless" : "headful") : "off"}`,
  );
  conn.start();

  const shutdown = () => {
    console.log("\n[tianshu-bridge] shutting down…");
    conn.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
