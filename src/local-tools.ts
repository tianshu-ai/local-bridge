// Native local tools exposed by the bridge — shell exec + file sync.
//
// These run DIRECTLY on the user's machine (unlike the browser tools,
// which proxy a child MCP server). They mirror the tool surface of
// tianshu's server-side `openshell` plugin (tool names, params, and
// result shapes) so an agent written against openshell's exec /
// sync_up / sync_down "just works" when the sandbox backend is a
// local-bridge device instead of a server sandbox.
//
// Semantics differ because the bridge is a CLIENT on the user's own
// box, with no tenant/project/task context and no server-side
// filesystem. ALL activity is jailed to a single fixed root directory
// (~/.tianshu_shell by default): exec's cwd + workdir, sync_up's read
// base, and sync_down's write dest all resolve within it, and any path
// that escapes the root is rejected.
//   - exec       : `bash -c <command>` on THIS machine, cwd inside root.
//   - sync_up    : read files under root → return their bytes (base64)
//                  to the agent. "up" = from your machine up to the agent.
//   - sync_down  : receive bytes (base64) from the agent → write them
//                  under root. "down" = from the agent down onto your box.
//
// Transport is base64-in-args/result over the existing reverse-MCP
// `tools/call` channel — no protocol changes, no server changes. Keep
// payloads modest; there's a hard per-file cap below.

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { textResult, type LocalTool, type ToolResult } from "./protocol.js";

// ─── tunables (mirroring openshell where it makes sense) ─────────────

const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60_000;
const MAX_EXEC_TIMEOUT_MS = 30 * 60_000;
const STDOUT_LINE_CAP = 2000;
const STDOUT_BYTE_CAP = 512_000;

// Base64 in a JSON-RPC frame is memory-bound; cap per-file bytes so a
// stray `sync_up({paths:['huge.iso']})` can't OOM the bridge or blow
// the WS frame. 8 MiB raw ≈ 11 MiB base64.
const MAX_FILE_BYTES = 32 * 1024 * 1024;
// Guard directory walks so a recursive sync_up of `~` can't fan out
// unbounded.
const MAX_SYNC_FILES = 500;

export interface LocalToolsOptions {
  /** The single fixed root that bounds ALL shell activity: exec cwd +
   *  workdir, sync_up read base, and sync_down write dest. Nothing the
   *  agent does via these tools can escape this directory. Defaults to
   *  ~/.tianshu_shell; override with --shell-root. */
  root: string;
  log: (m: string) => void;
}

// ─── shared helpers ──────────────────────────────────────────────────

function clampTimeout(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_EXEC_TIMEOUT_MS);
}

function truncate(text: string): { value: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length > STDOUT_LINE_CAP) {
    const head = lines.slice(0, STDOUT_LINE_CAP).join("\n");
    return {
      value: `${head}\n... (${lines.length - STDOUT_LINE_CAP} more lines truncated)`,
      truncated: true,
    };
  }
  if (text.length > STDOUT_BYTE_CAP) {
    return {
      value: `${text.slice(0, STDOUT_BYTE_CAP)}\n... (${text.length - STDOUT_BYTE_CAP} more bytes truncated)`,
      truncated: true,
    };
  }
  return { value: text, truncated: false };
}

/** Wrap a JSON object as the single text content block the reverse-MCP
 *  contract expects. Mirrors openshell tools returning a plain object;
 *  here we JSON-encode it into a text block. */
function jsonResult(obj: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], isError };
}

/** Resolve an agent-supplied path against a fixed base, refusing any
 *  result that escapes the base (path traversal / absolute paths that
 *  point elsewhere). Returns null if the path escapes. */
function resolveWithin(base: string, rel: string): string | null {
  const resolvedBase = path.resolve(base);
  // Treat the input as relative to base even if it's absolute-looking;
  // strip leading slashes so 'sync_down' can't be told to write /etc.
  const cleaned = rel.replace(/^[/\\]+/, "");
  const full = path.resolve(resolvedBase, cleaned);
  const withSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  if (full !== resolvedBase && !full.startsWith(withSep)) return null;
  return full;
}

// ─── exec ────────────────────────────────────────────────────────────

export function ExecTool(opts: LocalToolsOptions): LocalTool {
  return {
    descriptor: {
      name: "exec",
      description: `Run a shell command on THIS machine (the local-bridge device), via \`bash -c <command>\`.

All shell activity is confined to a fixed root directory: ${opts.root}. The command runs
there by default; a \`workdir\` must stay inside that root (paths escaping it are rejected).

Default timeout: ${DEFAULT_EXEC_TIMEOUT_MS / 1000}s. Raise \`timeout_ms\` for long tasks; cap ${MAX_EXEC_TIMEOUT_MS / 1000}s.
Outputs are truncated at ${STDOUT_LINE_CAP} lines / ${STDOUT_BYTE_CAP} bytes per stream — pipe to a file and read it back if you need the full output.
Runs with the bridge user's own permissions on their real machine — but is jailed to the root dir above.`,
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command. Equivalent to `bash -c <command>` on the bridge host, inside the shell root.",
          },
          workdir: {
            type: "string",
            description: `Working dir, relative to the shell root (${opts.root}). Defaults to the root itself. Must stay within it.`,
          },
          timeout_ms: {
            type: "integer",
            minimum: 1,
            maximum: MAX_EXEC_TIMEOUT_MS,
            description: `Override per-call timeout. Hard cap ${MAX_EXEC_TIMEOUT_MS}ms.`,
          },
        },
        required: ["command"],
      },
    },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const command = String(args.command ?? "");
      if (!command) {
        return jsonResult(
          { ok: false, exit_code: -1, stdout: "", stderr: "command is required", truncated: false, duration_ms: 0, timed_out: false },
          true,
        );
      }
      // Resolve the working dir inside the jail root. An escaping
      // workdir is a hard error (don't silently fall back — the agent
      // asked to run somewhere it isn't allowed).
      const workdirArg = typeof args.workdir === "string" && args.workdir ? args.workdir : ".";
      const workdir = resolveWithin(opts.root, workdirArg);
      if (!workdir) {
        return jsonResult(
          { ok: false, exit_code: -1, stdout: "", stderr: `workdir escapes shell root ${opts.root}`, truncated: false, duration_ms: 0, timed_out: false },
          true,
        );
      }
      const timeoutMs = clampTimeout(args.timeout_ms);
      const started = Date.now();
      // Ensure the root exists so the very first exec doesn't fail on a
      // missing cwd.
      try {
        fs.mkdirSync(opts.root, { recursive: true });
      } catch {
        /* best-effort; spawn will surface a real error */
      }
      return await new Promise<ToolResult>((resolve) => {
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        // Pick the platform's shell: bash on Unix, cmd.exe on Windows
        // (Windows has no bash by default). `cmd /d /s /c` runs the
        // command string as-is without an autorun profile.
        // Use the user's default shell in login+interactive mode so
        // .bashrc / .zshrc / .profile are all loaded (PATH, nvm, etc.).
        const userShell = process.env.SHELL || "/bin/bash";
        const [shellCmd, shellArgs] =
          process.platform === "win32"
            ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command]]
            : [userShell, ["-l", "-i", "-c", command]];
        const child = spawn(shellCmd, shellArgs, {
          cwd: fs.existsSync(workdir) ? workdir : opts.root,
          env: process.env,
          windowsHide: true,
        });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
        child.stdout?.on("data", (d) => {
          stdout += d.toString();
        });
        child.stderr?.on("data", (d) => {
          stderr += d.toString();
        });
        const finish = (exitCode: number) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const so = truncate(stdout);
          const se = truncate(stderr);
          resolve(
            jsonResult({
              ok: exitCode === 0 && !timedOut,
              exit_code: exitCode,
              stdout: so.value,
              stderr: timedOut ? `${se.value}${se.value ? "\n" : ""}[local-bridge] killed after ${timeoutMs}ms timeout` : se.value,
              truncated: so.truncated || se.truncated,
              duration_ms: Date.now() - started,
              timed_out: timedOut,
            }),
          );
        };
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(
            jsonResult(
              { ok: false, exit_code: -1, stdout: truncate(stdout).value, stderr: `spawn failed: ${err.message}`, truncated: false, duration_ms: Date.now() - started, timed_out: false },
              true,
            ),
          );
        });
        child.on("close", (code) => finish(code ?? -1));
      });
    },
  };
}

// ─── sync_up (local machine → agent) ─────────────────────────────────

/** Recursively collect files under a resolved path (or the single file
 *  itself). Returns [relPathFromBase, absPath] pairs. */
async function collectFiles(base: string, absStart: string, relStart: string): Promise<{ rel: string; abs: string }[]> {
  const out: { rel: string; abs: string }[] = [];
  const stat = await fsp.stat(absStart);
  if (stat.isFile()) {
    out.push({ rel: relStart, abs: absStart });
    return out;
  }
  if (!stat.isDirectory()) return out;
  const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
    const entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    for (const e of entries) {
      if (out.length >= MAX_SYNC_FILES) return;
      const childAbs = path.join(dirAbs, e.name);
      const childRel = path.posix.join(dirRel, e.name);
      if (e.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (e.isFile()) {
        out.push({ rel: childRel, abs: childAbs });
      }
    }
  };
  await walk(absStart, relStart);
  return out;
}

export function SyncUpTool(opts: LocalToolsOptions): LocalTool {
  return {
    descriptor: {
      name: "sync_up",
      description: `List files on this machine for syncing up to the server (bridge → server).

Scans the given paths inside the shell root and returns a manifest (path + size) of each file.
Does NOT transfer file content — use read_file for actual content retrieval.
Directories are scanned recursively.

Paths are resolved relative to the shell root (${opts.root}); paths that escape it are rejected.
At most ${MAX_SYNC_FILES} files per call.`,
      inputSchema: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description: `Files and/or directories to list, relative to the shell root (${opts.root}).`,
          },
        },
        required: ["paths"],
      },
    },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const raw = args.paths;
      if (!Array.isArray(raw) || raw.length === 0) {
        return jsonResult({ ok: false, error: "paths must be a non-empty string array" }, true);
      }
      const files: { path: string; bytes: number }[] = [];
      const skipped: { path: string; reason: string }[] = [];
      for (const p of raw) {
        const rel = String(p);
        const abs = resolveWithin(opts.root, rel);
        if (!abs) {
          skipped.push({ path: rel, reason: `path escapes shell root ${opts.root}` });
          continue;
        }
        let collected: { rel: string; abs: string }[];
        try {
          collected = await collectFiles(opts.root, abs, rel.replace(/^[/\\]+/, ""));
        } catch (err) {
          skipped.push({ path: rel, reason: err instanceof Error ? err.message : String(err) });
          continue;
        }
        for (const f of collected) {
          if (files.length >= MAX_SYNC_FILES) {
            skipped.push({ path: f.rel, reason: `exceeded ${MAX_SYNC_FILES}-file limit` });
            continue;
          }
          try {
            const st = await fsp.stat(f.abs);
            if (st.size > MAX_FILE_BYTES) {
              skipped.push({ path: f.rel, reason: `file ${st.size}B exceeds ${MAX_FILE_BYTES}B cap` });
              continue;
            }
            files.push({ path: f.rel, bytes: st.size });
          } catch (err) {
            skipped.push({ path: f.rel, reason: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      return jsonResult({
        ok: skipped.length === 0,
        base: opts.root,
        files,
        skipped,
      });
    },
  };
}

// ─── sync_down (agent → local machine) ───────────────────────────────

export function SyncDownTool(opts: LocalToolsOptions): LocalTool {
  return {
    descriptor: {
      name: "sync_down",
      description: `Verify files exist on this machine after syncing down from the server (server → bridge).

Checks that the given paths exist under the shell root (${opts.root}).
Actual file content is transferred via write_file before calling this.
This tool confirms the sync completed successfully.

Paths are resolved relative to the shell root; paths that escape it are rejected.`,
      inputSchema: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description: `File paths to verify, relative to the shell root (${opts.root}).`,
          },
        },
        required: ["paths"],
      },
    },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const raw = args.paths;
      if (!Array.isArray(raw) || raw.length === 0) {
        return jsonResult({ ok: false, error: "paths must be a non-empty string array" }, true);
      }
      const verified: { path: string; bytes: number }[] = [];
      const missing: { path: string; reason: string }[] = [];
      for (const p of raw) {
        const rel = String(p);
        const abs = resolveWithin(opts.root, rel);
        if (!abs) {
          missing.push({ path: rel, reason: `path escapes shell root ${opts.root}` });
          continue;
        }
        try {
          const st = await fsp.stat(abs);
          if (!st.isFile()) {
            missing.push({ path: rel, reason: "not a regular file" });
            continue;
          }
          verified.push({ path: rel, bytes: st.size });
        } catch {
          missing.push({ path: rel, reason: "file not found" });
        }
      }
      return jsonResult({
        ok: missing.length === 0,
        dest: opts.root,
        verified,
        missing,
      });
    },
  };
}

// ─── read_file (bridge → server, single file) ───────────────────────

export function ReadFileTool(opts: LocalToolsOptions): LocalTool {
  return {
    descriptor: {
      name: "read_file",
      description: `Read a single file from this machine and return its content as base64.

Path is resolved relative to the shell root (${opts.root}); paths that escape it are rejected.
Per-file cap ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MiB.`,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `File path, relative to the shell root (${opts.root}).`,
          },
        },
        required: ["path"],
      },
    },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const rel = String(args.path ?? "");
      if (!rel) {
        return jsonResult({ ok: false, error: "path is required" }, true);
      }
      const abs = resolveWithin(opts.root, rel);
      if (!abs) {
        return jsonResult({ ok: false, error: `path escapes shell root ${opts.root}` }, true);
      }
      try {
        const st = await fsp.stat(abs);
        if (!st.isFile()) {
          return jsonResult({ ok: false, error: "not a regular file" }, true);
        }
        if (st.size > MAX_FILE_BYTES) {
          return jsonResult({ ok: false, error: `file ${st.size}B exceeds ${MAX_FILE_BYTES}B cap` }, true);
        }
        const buf = await fsp.readFile(abs);
        return jsonResult({
          ok: true,
          path: rel,
          bytes: buf.length,
          base64: buf.toString("base64"),
        });
      } catch (err) {
        return jsonResult({ ok: false, error: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  };
}

// ─── write_file (server → bridge, single file) ──────────────────────

export function WriteFileTool(opts: LocalToolsOptions): LocalTool {
  return {
    descriptor: {
      name: "write_file",
      description: `Write a single file onto this machine from base64 content.

Path is resolved relative to the shell root (${opts.root}); paths that escape it are rejected.
Parent directories are created automatically. Existing files are overwritten.
Per-file cap ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MiB.`,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `Destination path, relative to the shell root (${opts.root}).`,
          },
          base64: {
            type: "string",
            description: "File content, base64-encoded.",
          },
        },
        required: ["path", "base64"],
      },
    },
    async run(args: Record<string, unknown>): Promise<ToolResult> {
      const rel = String(args.path ?? "");
      const b64 = String(args.base64 ?? "");
      if (!rel) {
        return jsonResult({ ok: false, error: "path is required" }, true);
      }
      const abs = resolveWithin(opts.root, rel);
      if (!abs) {
        return jsonResult({ ok: false, error: `path escapes shell root ${opts.root}` }, true);
      }
      let buf: Buffer;
      try {
        buf = Buffer.from(b64, "base64");
      } catch {
        return jsonResult({ ok: false, error: "invalid base64" }, true);
      }
      if (buf.length > MAX_FILE_BYTES) {
        return jsonResult({ ok: false, error: `file ${buf.length}B exceeds ${MAX_FILE_BYTES}B cap` }, true);
      }
      try {
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, buf);
        return jsonResult({ ok: true, path: rel, bytes: buf.length });
      } catch (err) {
        return jsonResult({ ok: false, error: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  };
}

// ─── factory ─────────────────────────────────────────────────────────

/** The fixed default shell root: ~/.tianshu_shell. All exec + sync
 *  activity is jailed here. Override with --shell-root. */
export function defaultShellRoot(): string {
  return path.join(os.homedir(), ".tianshu_shell");
}

/** Build the native local tool set, jailed to opts.root. */
export function localTools(opts: LocalToolsOptions): LocalTool[] {
  return [ExecTool(opts), ReadFileTool(opts), WriteFileTool(opts)];
}
