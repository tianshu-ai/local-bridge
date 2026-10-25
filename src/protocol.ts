// Reverse-MCP wire protocol (client side). Mirrors the authoritative
// contract in the tianshu server's plugins/reverse-mcp/PROTOCOL.md. We
// deliberately do NOT import any tianshu package — the bridge stays a
// standalone client that speaks the protocol.

export const MSG = {
  register: "reverse_mcp_register",
  unregister: "reverse_mcp_unregister",
  response: "reverse_mcp_response",
  request: "reverse_mcp_request",
  registered: "reverse_mcp_registered",
  /** Streaming progress during a tool call (bridge → server). */
  progress: "reverse_mcp_progress",
  // Local notifications (bridge → tray/desktop, not sent over WS)
  tool_active: "tool_active",
  tool_done: "tool_done",
} as const;

/** A tool this bridge advertises (MCP Tool shape). */
export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Whether this tool supports streaming progress updates. */
  streaming?: boolean;
}

/** Standard MCP tools/call result. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
  isError?: boolean;
}

/** A local tool: descriptor + handler. */
/** Callback to send streaming progress during tool execution. */
export type ProgressCallback = (data: string | { text?: string; [k: string]: unknown }) => void;

export interface LocalTool {
  descriptor: ToolDescriptor;
  run(args: Record<string, unknown>, signal?: AbortSignal, onProgress?: ProgressCallback): Promise<ToolResult>;
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

// ─── frame types ────────────────────────────────────────────────────

export interface RegisterMsg {
  type: typeof MSG.register;
  deviceId: string;
  label?: string;
  tools: ToolDescriptor[];
}
export interface RequestMsg {
  type: typeof MSG.request;
  id: string;
  method: string;
  params?: Record<string, unknown>;
}
export interface ResponseMsg {
  type: typeof MSG.response;
  id: string;
  result?: unknown;
  error?: { code: number; message: string };
}
export interface ProgressMsg {
  type: typeof MSG.progress;
  id: string;
  data: unknown;
}
