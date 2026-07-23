// `tsbridge tray` — a cross-platform system-tray wrapper around the CLI.
//
// One Node process, one code path for Windows / macOS / Linux, powered by
// systray2 (ships prebuilt tray binaries — no compiler, no runtime for the
// user to install). It mirrors the macOS Swift menu-bar app: a tray icon
// with a live status line + Start/Stop, a Settings hint, Open Log, and Quit.
// The bridge itself runs as a spawned `tsbridge --server …` child so the
// tray and the connection are decoupled (crash of one doesn't take the
// other down).
//
// Config lives at ~/.tianshu-bridge/config.json — the SAME file the Swift
// app uses, so switching between them keeps your settings.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSettingsWindow } from "./settings-window.js";
// systray2 is CommonJS. Under NodeNext the default-import interop
// mis-resolves the class (sees a namespace with no construct signature),
// so load it through createRequire to get the real constructor, and type
// it structurally so we don't depend on the package's ESM typings.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
type SysTrayItem = {
  title: string;
  tooltip: string;
  enabled?: boolean;
  hidden?: boolean;
  checked?: boolean;
  click?: () => void;
};
type SysTrayMenu = {
  icon: string;
  title: string;
  tooltip: string;
  isTemplateIcon?: boolean;
  items: SysTrayItem[];
};
interface SysTrayInstance {
  ready(): Promise<void>;
  onClick(cb: (action: { item?: unknown }) => void): void;
  onExit(cb: () => void): void;
  sendAction(action: unknown): Promise<unknown> | void;
  kill(exitNode?: boolean): Promise<void> | void;
}
type SysTrayCtor = new (conf: {
  menu: SysTrayMenu;
  debug?: boolean;
  copyDir?: boolean | string;
}) => SysTrayInstance;
const SysTray = require("systray2").default as SysTrayCtor;
// A separator menu item (systray2 uses the literal "<SEPARATOR>" title).
const SEPARATOR: SysTrayItem = { title: "<SEPARATOR>", tooltip: "", enabled: true };

// ─── config (mirrors app/TianshuBridge.swift Config) ────────────────

interface BridgeConfig {
  server: string;
  token: string;
  browser: boolean;
  engine: "own" | "stealth";
  headless: boolean;
  shell: boolean;
  device: string;
}

function configDir(): string {
  const dir = path.join(os.homedir(), ".tianshu-bridge");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function configPath(): string {
  return path.join(configDir(), "config.json");
}
function logPath(): string {
  return path.join(configDir(), "bridge.log");
}

function defaultConfig(): BridgeConfig {
  return {
    server: "ws://localhost:3110/ws",
    token: "",
    browser: true,
    engine: "own",
    headless: false,
    shell: false,
    device: "",
  };
}

function loadConfig(): BridgeConfig {
  const defaults = defaultConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) as Partial<BridgeConfig>;
    return { ...defaults, ...raw };
  } catch {
    return defaults;
  }
}

/** Ensure config.json exists on disk so "Edit settings" always has a
 *  file to open (first run hasn't Started the bridge yet, so nothing
 *  has written it). Returns the path. Best-effort. */
function ensureConfigFile(): string {
  const p = configPath();
  try {
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify(defaultConfig(), null, 2) + "\n");
    }
  } catch {
    /* best-effort */
  }
  return p;
}

// ─── tray icons ─────────────────────────────────────────────────────
//
// systray2 wants a base64 icon string: .ico on Windows, .png elsewhere.
// We ship two tiny icons next to the built module (assets/) and read them
// as base64 at runtime. Falls back to an empty string if missing (the
// tray still works, just without a custom glyph).

function iconBase64(state: "on" | "off"): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ext = process.platform === "win32" ? "ico" : "png";
  // dist/tray.js → ../assets/tray-<state>.<ext> (shipped in the package)
  const candidates = [
    path.join(here, "..", "assets", `tray-${state}.${ext}`),
    path.join(here, "assets", `tray-${state}.${ext}`),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p).toString("base64");
    } catch {
      /* try next */
    }
  }
  return "";
}

// ─── bridge child process ───────────────────────────────────────────

function buildArgs(cfg: BridgeConfig): string[] {
  const args = ["--server", cfg.server];
  if (cfg.token) args.push("--token", cfg.token);
  if (cfg.browser) {
    if (cfg.engine === "stealth") args.push("--browser-engine", "stealth");
    if (cfg.headless) args.push("--headless");
  } else {
    args.push("--no-browser");
  }
  if (cfg.shell) args.push("--shell");
  if (cfg.device) args.push("--device", cfg.device);
  return args;
}

/** Resolve how to launch the bridge CLI as a child.
 *  We re-invoke THIS package's own entry (dist/index.js) with the
 *  current node binary, so we don't depend on `tsbridge` being on PATH
 *  and don't recurse into the tray subcommand. */
function bridgeSpawn(cfg: BridgeConfig): { cmd: string; args: string[] } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entry = path.join(here, "index.js");
  return { cmd: process.execPath, args: [entry, ...buildArgs(cfg)] };
}

class Bridge {
  private proc: ChildProcess | null = null;
  onStateChange: (() => void) | null = null;

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed;
  }

  start(cfg: BridgeConfig): void {
    this.stop();
    const { cmd, args } = bridgeSpawn(cfg);
    // Log stdout/stderr to ~/.tianshu-bridge/bridge.log for troubleshooting.
    let out: number | "ignore" = "ignore";
    try {
      out = fs.openSync(logPath(), "a");
    } catch {
      out = "ignore";
    }
    const p = spawn(cmd, args, {
      stdio: ["ignore", out, out],
      // detached:false → child dies with the tray; that's what we want.
      windowsHide: true,
    });
    p.on("exit", () => {
      this.proc = null;
      this.onStateChange?.();
    });
    p.on("error", () => {
      this.proc = null;
      this.onStateChange?.();
    });
    this.proc = p;
    this.onStateChange?.();
  }

  stop(): void {
    if (this.proc && this.running) {
      this.proc.kill();
    }
    this.proc = null;
  }
}

// ─── tray ───────────────────────────────────────────────────────────

/**
 * systray2 copies its prebuilt tray binary into ~/.cache/node-systray/
 * (and also ships one inside the package's traybin/), but it does NOT
 * mark it executable on Unix — so the very first launch fails with
 * EACCES. Fix it up before we start: chmod +x every candidate binary
 * that exists. No-op on Windows (.exe needs no exec bit).
 */
function ensureTrayBinExecutable(): void {
  if (process.platform === "win32") return;
  const binName =
    process.platform === "darwin" ? "tray_darwin_release" : "tray_linux_release";
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(os.homedir(), ".cache", "node-systray", "2.1.4", binName),
    // package-internal copy (dist/../node_modules or bundled traybin)
    path.join(here, "..", "node_modules", "systray2", "traybin", binName),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) fs.chmodSync(p, 0o755);
    } catch {
      /* best-effort */
    }
  }
}

export async function runTray(): Promise<number> {
  let cfg = loadConfig();
  const bridge = new Bridge();
  ensureTrayBinExecutable();

  // Menu item objects (systray2 mutates `checked`/`title` in place then
  // we push an update-item action to reflect it in the tray).
  const statusItem = {
    title: "○ Stopped",
    tooltip: "Bridge connection status",
    enabled: false,
  };
  const serverItem = {
    title: `Server: ${cfg.server}`,
    tooltip: "Configured server (edit config.json to change)",
    enabled: false,
  };
  const startItem = {
    title: "Start",
    tooltip: "Start the bridge connection",
    enabled: true,
    hidden: false,
    click: () => {
      cfg = loadConfig(); // pick up any external config edits
      bridge.start(cfg);
    },
  };
  const stopItem = {
    title: "Stop",
    tooltip: "Stop the bridge connection",
    enabled: true,
    hidden: true,
    click: () => bridge.stop(),
  };
  const settingsItem = {
    title: "Settings…",
    tooltip: "Edit the bridge settings",
    enabled: true,
    click: () => {
      const p = ensureConfigFile();
      const c = loadConfig();
      // Native settings window (WinForms on Windows, AppleScript on
      // macOS). Falls back to opening the raw JSON on Linux / failure.
      const opened = openSettingsWindow(p, {
        server: c.server,
        token: c.token,
        browser: c.browser,
        engine: c.engine,
        headless: c.headless,
        shell: c.shell,
        device: c.device,
      });
      if (!opened) openPath(p);
    },
  };
  const logItem = {
    title: "Open log",
    tooltip: "Open bridge.log",
    enabled: true,
    click: () => openPath(logPath()),
  };
  const quitItem = {
    title: "Quit",
    tooltip: "Stop the bridge and quit",
    enabled: true,
    click: () => {
      bridge.stop();
      void systray.kill(true);
    },
  };

  const systray = new SysTray({
    menu: {
      icon: iconBase64("off"),
      isTemplateIcon: process.platform === "darwin",
      title: "Tianshu Bridge",
      tooltip: "Tianshu Bridge",
      items: [
        statusItem,
        serverItem,
        SEPARATOR,
        startItem,
        stopItem,
        SEPARATOR,
        settingsItem,
        logItem,
        SEPARATOR,
        quitItem,
      ],
    },
    debug: false,
    copyDir: true, // copy the tray binary to a stable temp dir (avoids
    //               running from inside node_modules on some setups)
  });

  // Reflect connection state in the tray whenever it changes.
  bridge.onStateChange = () => {
    const on = bridge.running;
    statusItem.title = on ? "● Connected" : "○ Stopped";
    startItem.hidden = on;
    stopItem.hidden = !on;
    void systray.sendAction({ type: "update-item", item: statusItem });
    void systray.sendAction({ type: "update-item", item: startItem });
    void systray.sendAction({ type: "update-item", item: stopItem });
    void systray.sendAction({
      type: "update-menu",
      menu: {
        icon: iconBase64(on ? "on" : "off"),
        isTemplateIcon: process.platform === "darwin",
        title: "Tianshu Bridge",
        tooltip: on ? "Tianshu Bridge: connected" : "Tianshu Bridge: stopped",
        items: [
          statusItem,
          serverItem,
          SEPARATOR,
          startItem,
          stopItem,
          SEPARATOR,
          settingsItem,
          logItem,
          SEPARATOR,
          quitItem,
        ],
      },
    });
  };

  systray.onClick((action: { item?: unknown }) => {
    const item = action.item as { click?: () => void } | undefined;
    if (item && typeof item.click === "function") item.click();
  });

  await systray.ready();
  console.log(
    `[local-bridge] tray running — config: ${configPath()}\n` +
      `  Click the tray icon → Start. Edit settings in config.json.`,
  );

  // Keep the process alive until the tray is killed.
  return await new Promise<number>((resolve) => {
    systray.onExit(() => resolve(0));
  });
}

// ─── util ───────────────────────────────────────────────────────────

/** Open a file with the OS default handler (cross-platform).
 *  Windows: `cmd /c start "" file` is flaky under a detached spawn and
 *  fails if the file type has no association, so open the file's default
 *  editor via a small chain — try the shell association, then notepad as
 *  a guaranteed fallback for our .json/.log text files. */
function openPath(target: string): void {
  const plat = process.platform;
  try {
    if (plat === "win32") {
      // `explorer <file>` opens with the registered handler; if none,
      // fall back to notepad (always present) for our text files.
      const child = spawn("cmd", ["/d", "/s", "/c", "start", "", target], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      child.on("error", () => {
        try {
          spawn("notepad", [target], { stdio: "ignore", detached: true }).unref();
        } catch {
          /* give up */
        }
      });
      child.unref();
      return;
    }
    const cmd = plat === "darwin" ? "open" : "xdg-open";
    spawn(cmd, [target], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best-effort */
  }
}
