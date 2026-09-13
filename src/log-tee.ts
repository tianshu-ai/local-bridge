// Rolling-file log tee for the local-bridge client.
//
// Motivation (Yu, 2026-09-13): "bridge tool 也记日志到文件，回头我把
// tianshu 和 bridge 的日志拉到一起看看".
//
// Tianshu server got rolling logs in v0.51.0 (packages/server/src/
// setup/log-tee.ts). This is the client-side twin: everything
// local-bridge writes to stdout / stderr (reconnect loops,
// heartbeat "no response" warnings, tool-call round-trips,
// uncaught exceptions) is teed to
// `~/.tianshu-bridge/logs/bridge-YYYY-MM-DD.log`.
//
// Correlating the two log streams by timestamp is the fastest way
// to answer the open question: "when a bridge_*_exec hangs, is it
// tianshu server or the bridge client that stops responding first?"
//
// Rotation: one file per calendar day, retention configurable
// (default 7 days), pruned once on process start.
//
// Zero third-party deps: node:fs / node:os / node:path only. Uses
// fs.appendFileSync so lines that precede a crash still land on
// disk.
//
// Env knobs:
//   TIANSHU_BRIDGE_LOG_DIR         override log directory (default
//                                  `<userHomeDir>/.tianshu-bridge/logs`)
//   TIANSHU_BRIDGE_LOG_KEEP_DAYS   retention days (default 7)
//   TIANSHU_BRIDGE_LOG_DISABLE=1   opt out entirely

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_KEEP_DAYS = 7;
const MIN_KEEP_DAYS = 1;
const MAX_KEEP_DAYS = 365;

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function resolveKeepDays(): number {
  const raw = process.env.TIANSHU_BRIDGE_LOG_KEEP_DAYS;
  if (!raw) return DEFAULT_KEEP_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_KEEP_DAYS;
  return Math.max(MIN_KEEP_DAYS, Math.min(MAX_KEEP_DAYS, Math.floor(n)));
}

function resolveLogDir(): string {
  const override = process.env.TIANSHU_BRIDGE_LOG_DIR;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".tianshu-bridge", "logs");
}

function pruneOldLogs(dir: string, keepDays: number): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoffMs = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    if (!/^bridge-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const full = join(dir, name);
    try {
      const s = statSync(full);
      if (s.mtimeMs < cutoffMs) unlinkSync(full);
    } catch {
      // ignore
    }
  }
}

function chunkToString(chunk: unknown, encoding?: BufferEncoding): string {
  if (chunk == null) return "";
  if (typeof chunk === "string") return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString(encoding ?? "utf8");
  return String(chunk);
}

interface LogTeeState {
  dir: string;
  currentStamp: string;
  currentPath: string;
  installed: boolean;
}

let state: LogTeeState | null = null;

/**
 * Install the tee. Idempotent — repeat calls are no-ops. Call as
 * early as possible in `src/index.ts` (right after imports) so all
 * subsequent stdout / stderr writes are captured.
 *
 * On failure (unwritable dir, permission errors) the tee silently
 * skips and the CLI still runs with the original stdout / stderr.
 */
export function installLogTee(): void {
  if (state?.installed) return;
  if (process.env.TIANSHU_BRIDGE_LOG_DISABLE === "1") return;

  const dir = resolveLogDir();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (err) {
    process.stderr.write(
      `[log-tee] disabled: cannot create ${dir}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }

  const stamp = todayStamp();
  const path = join(dir, `bridge-${stamp}.log`);

  state = {
    dir,
    currentStamp: stamp,
    currentPath: path,
    installed: true,
  };

  pruneOldLogs(dir, resolveKeepDays());

  const header = `\n=== local-bridge boot ${new Date().toISOString()} pid=${process.pid} argv=${JSON.stringify(process.argv.slice(2))} ===\n`;
  try {
    appendFileSync(path, header);
  } catch {
    // ignore
  }

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  function teeToFile(text: string): void {
    if (!state) return;
    const stampNow = todayStamp();
    if (stampNow !== state.currentStamp) {
      state.currentStamp = stampNow;
      state.currentPath = join(state.dir, `bridge-${stampNow}.log`);
      try {
        pruneOldLogs(state.dir, resolveKeepDays());
      } catch {
        // ignore
      }
    }
    try {
      appendFileSync(state.currentPath, text);
    } catch {
      // ignore — never break stdout on log write failure
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout.write as any) = function patchedStdoutWrite(
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const encoding: BufferEncoding | undefined =
      typeof encodingOrCb === "string" ? (encodingOrCb as BufferEncoding) : undefined;
    teeToFile(chunkToString(chunk, encoding));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origStdoutWrite as any)(chunk, encodingOrCb, cb);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr.write as any) = function patchedStderrWrite(
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    const encoding: BufferEncoding | undefined =
      typeof encodingOrCb === "string" ? (encodingOrCb as BufferEncoding) : undefined;
    teeToFile(chunkToString(chunk, encoding));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origStderrWrite as any)(chunk, encodingOrCb, cb);
  };

  process.on("uncaughtException", (err) => {
    teeToFile(`[uncaughtException] ${err.stack ?? err.message ?? String(err)}\n`);
  });
  process.on("unhandledRejection", (reason) => {
    const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    teeToFile(`[unhandledRejection] ${text}\n`);
  });

  origStdoutWrite(`[log-tee] bridge logs \u2192 ${path} (keep ${resolveKeepDays()} days)\n`);
}

export function currentLogPath(): string | null {
  return state?.currentPath ?? null;
}

export function isLogTeeInstalled(): boolean {
  return state?.installed === true;
}
