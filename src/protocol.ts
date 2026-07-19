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
} as const;

/** A tool this bridge advertises (MCP Tool shape). */
export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Standard MCP tools/call result. */
export interface ToolResult {
  content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
  isError?: boolean;
}

/** A local tool: descriptor + handler. */
export interface LocalTool {
  descriptor: ToolDescriptor;
  run(args: Record<string, unknown>): Promise<ToolResult>;
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
