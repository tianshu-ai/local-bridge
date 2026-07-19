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
│    tools     │ ◀──── tools/call ─│   → agent uses    │
└──────────────┘ ──── result ─────▶ │     your tools    │
                                    └──────────────────┘
```

## Install & run

Install globally, then use the short `tsbridge` command:

```bash
npm i -g @tianshu-ai/local-bridge
tsbridge --server wss://your-tianshu.example.com/ws --token ***
```

Or run one-off with `npx` (no install):

```bash
npx @tianshu-ai/local-bridge --server wss://your-tianshu.example.com/ws --token ***
```

The **Local Bridge** panel in tianshu shows a ready-to-copy command with
your server URL + token filled in.

### macOS menu-bar app

Prefer a UI? Build a tiny native menu-bar app (no Electron) that wraps
the CLI — a menu-bar icon with Start/Stop + Settings (server / token /
browser engine / headless):

```bash
npm i -g @tianshu-ai/local-bridge      # provides the tsbridge CLI the app drives
curl -fsSL https://raw.githubusercontent.com/tianshu-ai/local-bridge/main/app/install-app.sh | bash
# or, from a clone:  bash app/install-app.sh --run
```

It installs `Tianshu Bridge.app` to `~/Applications` (menu-bar only, no
Dock icon). Click the bolt icon → Settings to configure, then Start.
Requires Xcode command line tools (`xcode-select --install`) for the
one-time `swiftc` build. First launch: right-click → Open (unsigned
local build).

For a local dev server with auth off, the token is optional:

```bash
tsbridge --server ws://localhost:3110/ws
```

> The `tsbridge` and `tianshu-local-bridge` commands are equivalent.

### Keeping it updated

```bash
tsbridge update            # update to the latest version if newer (default)
tsbridge update --check    # just check; exit 1 if an update is available
tsbridge update --dry-run  # print the npm command without running it
tsbridge update --tag next # target a non-`latest` dist-tag
tsbridge version           # print the installed version
```

(Same semantics as `tianshu update`.)

### Flags

| flag | meaning |
|---|---|
| `--server <url>` | tianshu chat WS endpoint (required), e.g. `wss://host/ws` |
| `--token <token>` | connection token from the Local Bridge panel |
| `--device <id>` | stable device id (default: hostname) |
| `--label <name>` | human label shown in the panel |
| `--no-browser` | don't expose browser tools |
| `--headless` | run the browser without a window (default: headful) |
| `--cdp <url>` | connect to an already-running Chrome's CDP endpoint (default probe `http://127.0.0.1:9222`; `off` to skip) |
| `--chrome-channel <ch>` | which installed browser to launch: `chrome` (default), `msedge`, … |
| `--user-data-dir <dir>` | reuse a Chrome profile dir so logins carry over |

**No Chromium download.** The bridge uses *your* Chrome:

1. If a Chrome is already running with `--remote-debugging-port=9222`,
   it connects to that (your real browser — real cookies + session).
2. Otherwise it launches your system-installed Google Chrome via
   Playwright's `channel: "chrome"`. Pass `--user-data-dir` to reuse
   your logged-in profile.

To expose your everyday browser, start Chrome with a debugging port:

```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
```

## Tools

Both engines expose the **full Playwright-MCP toolset** (navigate,
snapshot, click, type, fill_form, evaluate, tabs, screenshot, …). Only
the underlying browser differs:

- **own** — `@playwright/mcp` pointed at *your* Chrome: connects over CDP
  to a Chrome already running with `--remote-debugging-port`, else
  launches your system Chrome (`--browser chrome`). Real cookies +
  fingerprint, no Chromium download.
- **stealth** — `cloakbrowser-mcp`: the same toolset on CloakBrowser
  stealth Chromium (source-level anti-bot-detection patches).

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
