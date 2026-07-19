// Bridge a downstream local MCP server (e.g. cloakbrowser-mcp) into the
// reverse-MCP tool set. We spawn the child over stdio, act as its MCP
// client, and wrap each of its tools as a LocalTool that proxies
// tools/call. This turns local-bridge into a general "expose a local
// MCP server to tianshu" bridge — browser (stealth) is the first user.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { textResult, type LocalTool, type ToolDescriptor, type ToolResult } from "./protocol.js";

export interface McpChildOptions {
  /** Executable to spawn (e.g. "npx"). */
  command: string;
  /** Args (e.g. ["-y", "cloakbrowser-mcp@latest"]). */
  args: string[];
  /** Extra env for the child. */
  env?: Record<string, string>;
  /** Prefix stripped/added? We keep upstream names as-is; the server
   *  already namespaces to bridge_<device>_<name>. */
  clientName?: string;
  log: (m: string) => void;
}

/** Start the child MCP server, list its tools, and return them wrapped
 *  as LocalTools. The Client stays connected for the process lifetime;
 *  tools/call is proxied straight through. */
/** Our own working dir for the browser MCP children. Fixed + explicit
 *  so output never lands in a surprise cwd. The crash we hit
 *  (mkdir '/.playwright-mcp') was cloakbrowser/@playwright-mcp
 *  resolving `.playwright-mcp` against cwd, which is `/` when launched
 *  from a GUI app. Pin it under ~/.tianshu-bridge instead. */
export function bridgeOutputDir(): string {
  const dir = path.join(os.homedir(), ".tianshu-bridge", "playwright-mcp");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
  return dir;
}

export async function connectMcpChild(opts: McpChildOptions): Promise<LocalTool[]> {
  const baseEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (!baseEnv.HOME) baseEnv.HOME = os.homedir();
  // Pin the output dir explicitly (both cloakbrowser-mcp via env and
  // @playwright/mcp via --output-dir honor this), so it never resolves
  // to a bad cwd like '/'.
  const outDir = bridgeOutputDir();
  baseEnv.PLAYWRIGHT_MCP_OUTPUT_DIR = outDir;
  const transport = new StdioClientTransport({
    command: opts.command,
    args: opts.args,
    env: { ...baseEnv, ...(opts.env ?? {}) } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name: opts.clientName ?? "tianshu-local-bridge", version: "0.1.0" });
  opts.log(`starting downstream MCP: ${opts.command} ${opts.args.join(" ")}`);
  await client.connect(transport);

  const listed = await client.listTools();
  const tools: LocalTool[] = [];
  for (const t of listed.tools) {
    const descriptor: ToolDescriptor = {
      name: t.name,
      description: t.description ?? undefined,
      inputSchema: (t.inputSchema as Record<string, unknown> | undefined) ?? undefined,
    };
    tools.push({
      descriptor,
      async run(args: Record<string, unknown>): Promise<ToolResult> {
        try {
          const res = await client.callTool({ name: t.name, arguments: args });
          // The MCP result already has { content, isError }. Pass it
          // through; our protocol.ToolResult shape matches.
          const content = Array.isArray((res as { content?: unknown }).content)
            ? ((res as { content: ToolResult["content"] }).content)
            : [];
          return {
            content: content.length ? content : [{ type: "text", text: "(no content)" }],
            isError: (res as { isError?: boolean }).isError === true,
          };
        } catch (err) {
          return textResult(
            `downstream MCP call "${t.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
            true,
          );
        }
      },
    });
  }
  opts.log(`downstream MCP ready: ${tools.length} tools`);
  return tools;
}
