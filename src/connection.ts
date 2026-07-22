// WebSocket dial-in to a tianshu server + reverse-MCP request handling.
//
// The bridge connects OUTBOUND (works behind NAT/firewall), authenticates
// with a Bearer token, registers its tools, then serves tools/call
// requests the server sends. Auto-reconnects with backoff.

import WebSocket from "ws";
import { MSG, textResult, type LocalTool, type RequestMsg, type ResponseMsg, type RegisterMsg } from "./protocol.js";

export interface BridgeOptions {
  server: string; // wss://host/ws
  token?: string;
  deviceId: string;
  label?: string;
  tools: LocalTool[];
  log?: (msg: string) => void;
}

const RECONNECT_BASE_MS = 1000;
// Capped low so a server restart (down for a few seconds) reconnects
// promptly instead of getting stuck on a long backoff. The first
// retry after a drop is immediate (see the close handler).
const RECONNECT_MAX_MS = 10_000;

// Heartbeat: proactively detect "half-open" / silently-dead sockets
// that never fire a `close` event (Wi-Fi switch, laptop sleep, NAT
// timeout, server process vanished without a TCP FIN). We send a WS
// ping every HEARTBEAT_MS; the server auto-replies with pong (RFC
// default in the `ws` lib). If we go DEAD_AFTER_MS without ANY sign of
// life (no pong, no message, nothing buffered to send, no tool call in
// flight) we consider the socket dead and terminate it — that fires
// `close`, which runs the normal reconnect-with-backoff path.
const HEARTBEAT_MS = 25_000;
// A socket is declared dead after ~2.5 missed heartbeats of total
// silence. Kept comfortably above HEARTBEAT_MS so one slow round-trip
// doesn't nuke a healthy link.
const DEAD_AFTER_MS = 65_000;

export class BridgeConnection {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private readonly toolsByName = new Map<string, LocalTool>();
  private readonly log: (m: string) => void;
  // Liveness tracking. `lastActivityAt` bumps on any inbound frame,
  // pong, or successful send. `inFlight` counts tool calls currently
  // executing — a busy connection is by definition alive + must not be
  // torn down mid-task.
  private lastActivityAt = 0;
  private inFlight = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: BridgeOptions) {
    this.log = opts.log ?? ((m) => console.log(m));
    for (const t of opts.tools) this.toolsByName.set(t.descriptor.name, t);
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.stopHeartbeat();
    try {
      this.ws?.send(JSON.stringify({ type: MSG.unregister }));
    } catch {
      /* ignore */
    }
    this.ws?.close();
    this.ws = null;
  }

  /** Is this connection currently doing work? True while one or more
   *  tool calls are executing, or while there are bytes still queued
   *  to send (e.g. a large tool result mid-flight). Used by the
   *  heartbeat so we never tear down a busy socket. */
  isBusy(): boolean {
    return this.inFlight > 0 || (this.ws?.bufferedAmount ?? 0) > 0;
  }

  // ── heartbeat ────────────────────────────────────────────────

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      // A busy or recently-active socket is alive by definition —
      // don't judge it dead, just keep pinging.
      const silentFor = Date.now() - this.lastActivityAt;
      if (silentFor >= DEAD_AFTER_MS && !this.isBusy()) {
        this.log(
          `no response for ${Math.round(silentFor / 1000)}s — assuming dead link, forcing reconnect`,
        );
        // terminate() (not close()) drops a half-open socket
        // immediately; the 'close' handler then runs reconnect.
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        return;
      }
      // Otherwise probe: server auto-pongs, bumping lastActivityAt.
      try {
        ws.ping();
        this.log(`heartbeat: ping (silent ${Math.round(silentFor / 1000)}s, busy=${this.isBusy()})`);
      } catch (err) {
        // A failed ping means the socket is already broken; force it
        // through the close/reconnect path rather than waiting.
        this.log(
          `heartbeat: ping failed (${err instanceof Error ? err.message : String(err)}), terminating`,
        );
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
    }, HEARTBEAT_MS);
    // Don't let the heartbeat keep the process alive on its own.
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private connect(): void {
    const headers: Record<string, string> = {};
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    const ws = new WebSocket(this.opts.server, { headers });
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      this.lastActivityAt = Date.now();
      this.log(
        `connected to ${this.opts.server} (heartbeat ${HEARTBEAT_MS / 1000}s, dead-after ${DEAD_AFTER_MS / 1000}s)`,
      );
      const reg: RegisterMsg = {
        type: MSG.register,
        deviceId: this.opts.deviceId,
        label: this.opts.label,
        tools: this.opts.tools.map((t) => t.descriptor),
      };
      ws.send(JSON.stringify(reg));
      this.startHeartbeat(ws);
    });

    // Any pong is a sign of life. (Server auto-pongs our pings.)
    ws.on("pong", () => {
      this.lastActivityAt = Date.now();
      this.log("heartbeat: pong");
    });

    ws.on("message", (raw) => {
      this.lastActivityAt = Date.now();
      let msg: { type?: string } & Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case MSG.registered:
          if ((msg as { ok?: boolean }).ok) {
            this.log(`registered device "${this.opts.deviceId}" (${this.toolsByName.size} tools)`);
          } else {
            this.log(`register rejected: ${(msg as { error?: string }).error ?? "unknown"}`);
          }
          break;
        case MSG.request:
          void this.handleRequest(msg as unknown as RequestMsg);
          break;
        default:
          // Ignore other chat-channel traffic on the shared /ws.
          break;
      }
    });

    ws.on("close", (code, reason) => {
      this.stopHeartbeat();
      this.ws = null;
      const why = `code=${code}${reason?.length ? ` reason=${reason.toString()}` : ""}`;
      if (this.closed) {
        this.log(`socket closed after stop (${why})`);
        return;
      }
      // First retry after a drop is immediate — a server restart is
      // usually back within a second, and waiting a full backoff step
      // feels like "it didn't reconnect". Subsequent retries back off.
      const delay =
        this.attempt === 0
          ? 0
          : Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
      this.attempt++;
      this.log(
        delay === 0
          ? `disconnected (${why}); reconnecting now`
          : `disconnected (${why}); reconnecting in ${Math.round(delay / 1000)}s`,
      );
      setTimeout(() => {
        if (!this.closed) this.connect();
      }, delay);
    });

    ws.on("error", (err) => {
      const e = err as NodeJS.ErrnoException & { message?: string };
      const detail =
        [e.code, e.message].filter(Boolean).join(" ") ||
        (err ? String(err) : "unknown (connection refused / handshake rejected?)");
      this.log(`socket error: ${detail}`);
    });

    // Surface non-101 handshake responses (auth/path problems), which
    // otherwise arrive as an opaque error.
    ws.on("unexpected-response", (_req, res) => {
      this.log(
        `server rejected the WebSocket upgrade: HTTP ${res.statusCode} ${res.statusMessage ?? ""} ` +
          `(check --server URL/path and --token). Expected /ws to accept an upgrade.`,
      );
    });
  }

  private send(msg: ResponseMsg): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch (err) {
      this.log(`failed to send response: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleRequest(req: RequestMsg): Promise<void> {
    if (req.method !== "tools/call") {
      this.send({ type: MSG.response, id: req.id, error: { code: -32601, message: `unsupported method: ${req.method}` } });
      return;
    }
    const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    const tool = params.name ? this.toolsByName.get(params.name) : undefined;
    if (!tool) {
      this.send({ type: MSG.response, id: req.id, error: { code: -32602, message: `unknown tool: ${params.name}` } });
      return;
    }
    // Mark the connection busy for the duration of the tool call so
    // the heartbeat never tears it down mid-task (a slow tool =
    // silence on the wire, but the link is fine).
    this.inFlight += 1;
    try {
      const result = await tool.run(params.arguments ?? {});
      this.send({ type: MSG.response, id: req.id, result });
    } catch (err) {
      this.send({
        type: MSG.response,
        id: req.id,
        result: textResult(`tool "${params.name}" failed: ${err instanceof Error ? err.message : String(err)}`, true),
      });
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastActivityAt = Date.now();
    }
  }
}
