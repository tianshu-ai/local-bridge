// Bridge a downstream local MCP server (e.g. cloakbrowser-mcp) into the
// reverse-MCP tool set. We spawn the child over stdio, act as its MCP
// client, and wrap each of its tools as a LocalTool that proxies
// tools/call. This turns local-bridge into a general "expose a local
// MCP server to tianshu" bridge — browser (stealth) is the first user.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
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

/**
 * Resolve the command+args for a downstream MCP package.
 * In normal CLI usage where npx is on PATH, returns { command: "npx", args } as-is.
 * In embedded/packaged mode (e.g. Tauri app, no npx), falls back to running
 * the package's bin entry directly via the current Node (process.execPath).
 */
export function resolveEmbeddedMcp(
  pkg: string,
  binEntry: string,
  extraArgs: string[] = [],
): { command: string; args: string[] } {
  // Try to find npx
  const npxName = process.platform === "win32" ? "npx.cmd" : "npx";
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  const npxFound = pathDirs.some((d) => {
    try {
      fs.accessSync(path.join(d, npxName), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (npxFound) {
    return { command: npxName, args: ["-y", `${pkg}@latest`, ...extraArgs] };
  }
  // Fallback: resolve from local node_modules (pre-bundled in payload).
  // The package's bin entry is relative to its package dir.
  let entryPath: string | undefined;
  try {
    // require.resolve from our own module root will find it in the
    // payload's node_modules tree.
    const esmRequire = createRequire(import.meta.url);
    const pkgJson = path.dirname(
      esmRequire.resolve(`${pkg}/package.json`, { paths: [__dirname, process.cwd()] }),
    );
    entryPath = path.join(pkgJson, binEntry);
  } catch {
    // Last resort: try sibling node_modules
    const candidate = path.join(__dirname, "..", "node_modules", pkg, binEntry);
    if (fs.existsSync(candidate)) entryPath = candidate;
  }
  if (!entryPath || !fs.existsSync(entryPath)) {
    throw new Error(
      `Cannot find ${pkg} locally and npx is not available. ` +
        `Ensure ${pkg} is pre-installed in node_modules or npx is on PATH.`,
    );
  }
  return { command: process.execPath, args: [entryPath, ...extraArgs] };
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
