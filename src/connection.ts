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
const RECONNECT_MAX_MS = 30_000;

export class BridgeConnection {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private readonly toolsByName = new Map<string, LocalTool>();
  private readonly log: (m: string) => void;

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
    try {
      this.ws?.send(JSON.stringify({ type: MSG.unregister }));
    } catch {
      /* ignore */
    }
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    const headers: Record<string, string> = {};
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    const ws = new WebSocket(this.opts.server, { headers });
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      this.log(`connected to ${this.opts.server}`);
      const reg: RegisterMsg = {
        type: MSG.register,
        deviceId: this.opts.deviceId,
        label: this.opts.label,
        tools: this.opts.tools.map((t) => t.descriptor),
      };
      ws.send(JSON.stringify(reg));
    });

    ws.on("message", (raw) => {
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

    ws.on("close", () => {
      this.ws = null;
      if (this.closed) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
      this.attempt++;
      this.log(`disconnected; reconnecting in ${Math.round(delay / 1000)}s`);
      setTimeout(() => {
        if (!this.closed) this.connect();
      }, delay);
    });

    ws.on("error", (err) => {
      this.log(`socket error: ${err instanceof Error ? err.message : String(err)}`);
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
    try {
      const result = await tool.run(params.arguments ?? {});
      this.send({ type: MSG.response, id: req.id, result });
    } catch (err) {
      this.send({
        type: MSG.response,
        id: req.id,
        result: textResult(`tool "${params.name}" failed: ${err instanceof Error ? err.message : String(err)}`, true),
      });
    }
  }
}
