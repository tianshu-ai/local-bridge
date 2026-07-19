# local-bridge

`@tianshu-ai/local-bridge` — a lightweight local client that connects
your machine's tools (browser, and more) into a
[tianshu](https://github.com/tianshu-ai/tianshu) server via
**reverse-MCP**.

tianshu runs on a server. This bridge runs on **your** computer, dials
out to the server over a WebSocket, and registers itself as an MCP
server. The server-side agent can then drive your local tools — as if
they were built in — but scoped to your own sessions only.

```
your machine                         tianshu server
┌──────────────┐   outbound WSS    ┌──────────────────┐
│ local-bridge │ ────────────────▶ │ /ws (Local Bridge │
│  • browser   │   register tools  │   plugin)         │
│  • echo      │ ◀──── tools/call ─│   → agent uses    │
└──────────────┘ ──── result ─────▶ │     your tools    │
                                    └──────────────────┘
```

## Install & run

Open the **Local Bridge** panel in tianshu, copy the command it shows,
and run it on your machine:

```bash
npx @tianshu-ai/local-bridge --server wss://your-tianshu.example.com/ws --token ***
```

For a local dev server with auth off, the token is optional:

```bash
npx @tianshu-ai/local-bridge --server ws://localhost:3110/ws
```

### Flags

| flag | meaning |
|---|---|
| `--server <url>` | tianshu chat WS endpoint (required), e.g. `wss://host/ws` |
| `--token <token>` | connection token from the Local Bridge panel |
| `--device <id>` | stable device id (default: hostname) |
| `--label <name>` | human label shown in the panel |
| `--headful` | show the browser window (default: headless) |
| `--no-browser` | expose only the connectivity `echo` tool |

The first run downloads a Chromium build for Playwright. Skip it with
`--no-browser` if you only want to verify connectivity.

## Tools

- `echo` — connectivity check.
- `browser_navigate` / `browser_get_text` / `browser_click` /
  `browser_screenshot` — drive a real local browser via Playwright.

## Protocol

The bridge speaks the reverse-MCP protocol defined authoritatively in the
server repo: `plugins/reverse-mcp/PROTOCOL.md`. It's a thin envelope
around standard MCP JSON-RPC over the authenticated chat WebSocket. This
client imports no tianshu package.

## Develop

```bash
npm install
npm run build
node dist/index.js --server ws://localhost:3110/ws --no-browser
```

Repo: <https://github.com/tianshu-ai/local-bridge>

Apache-2.0.
