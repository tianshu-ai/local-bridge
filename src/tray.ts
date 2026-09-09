// `tsbridge tray` — multi-profile system-tray bridge manager.
//
// One Node process, one tray icon. Each profile in config.json gets its
// own child process and its own status line in the tray menu. Profiles
// marked autoStart launch when the tray starts.
//
// Config lives at ~/.tianshu-bridge/config.json — supports both the
// legacy single-server format and the new multi-profile format.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, configPath, ensureConfigFile, logPath, createProfile, type BridgeProfile, type MultiConfig } from "./profiles.js";
import { BridgeManager } from "./bridge-manager.js";
import { openSettingsWindow } from "./settings-window.js";
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
const SEPARATOR: SysTrayItem = { title: "<SEPARATOR>", tooltip: "", enabled: true };

// ── icons ──────────────────────────────────────────────────────────

function iconBase64(state: "on" | "off"): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ext = process.platform === "win32" ? "ico" : "png";
  const candidates = [
    path.join(here, "..", "assets", `tray-${state}.${ext}`),
    path.join(here, "assets", `tray-${state}.${ext}`),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p).toString("base64"); } catch { /* try next */ }
  }
  return "";
}

// ── tray binary fix ────────────────────────────────────────────────

import os from "node:os";

function ensureTrayBinExecutable(): void {
  if (process.platform === "win32") return;
  const binName = process.platform === "darwin" ? "tray_darwin_release" : "tray_linux_release";
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(os.homedir(), ".cache", "node-systray", "2.1.4", binName),
    path.join(here, "..", "node_modules", "systray2", "traybin", binName),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) fs.chmodSync(p, 0o755); } catch { /* best-effort */ }
  }
}

// ── state indicators ───────────────────────────────────────────────

const STATE_ICON = { stopped: "○", starting: "◌", running: "●", error: "✕" } as const;

// ── tray ───────────────────────────────────────────────────────────

export async function runTray(): Promise<number> {
  let config = loadConfig();
  const manager = new BridgeManager();
  ensureTrayBinExecutable();

  // ── Build menu items ───────────────────────────────────────────

  function buildProfileItems(): SysTrayItem[] {
    if (config.profiles.length === 0) {
      return [{
        title: "No profiles configured",
        tooltip: "Open Settings to add a server profile",
        enabled: false,
      }];
    }
    const items: SysTrayItem[] = [];
    for (const p of config.profiles) {
      const state = manager.getState(p.id);
      const running = manager.isRunning(p.id);
      // Profile status line
      items.push({
        title: `${STATE_ICON[state]} ${p.name} — ${p.server.replace(/^wss?:\/\//, "").replace(/\/ws$/, "")}`,
        tooltip: `${p.name}: ${state}`,
        enabled: false,
      });
      // Start/Stop toggle
      items.push({
        title: running ? `    Stop ${p.name}` : `    Start ${p.name}`,
        tooltip: running ? `Stop profile ${p.name}` : `Start profile ${p.name}`,
        enabled: true,
        click: () => {
          if (running) {
            manager.stop(p.id);
          } else {
            manager.start(p);
          }
        },
      });
    }
    return items;
  }

  const settingsItem: SysTrayItem = {
    title: "Settings…",
    tooltip: "Edit bridge settings",
    enabled: true,
    click: () => {
      const p = ensureConfigFile();
      openSettingsWindow(p, config.profiles[0] ?? {
        server: "ws://localhost:3110/ws",
        token: "",
        browser: true,
        engine: "own",
        headless: false,
        shell: false,
        device: "",
      });
    },
  };

  const startAllItem: SysTrayItem = {
    title: "Start All",
    tooltip: "Start all profiles",
    enabled: true,
    click: () => {
      config = loadConfig();
      for (const p of config.profiles) manager.start(p);
    },
  };

  const stopAllItem: SysTrayItem = {
    title: "Stop All",
    tooltip: "Stop all profiles",
    enabled: true,
    click: () => manager.stopAll(),
  };

  const logItem: SysTrayItem = {
    title: "Open Log",
    tooltip: "Open bridge log",
    enabled: true,
    click: () => openPath(logPath()),
  };

  const quitItem: SysTrayItem = {
    title: "Quit",
    tooltip: "Stop all and quit",
    enabled: true,
    click: () => {
      manager.stopAll();
      void systray.kill(true);
    },
  };

  function buildMenu(): SysTrayMenu {
    const anyRunning = manager.isAnyRunning();
    return {
      icon: iconBase64(anyRunning ? "on" : "off"),
      isTemplateIcon: process.platform === "darwin",
      title: "Tianshu Bridge",
      tooltip: anyRunning
        ? `Tianshu Bridge: ${config.profiles.filter((p) => manager.isRunning(p.id)).length}/${config.profiles.length} connected`
        : "Tianshu Bridge: stopped",
      items: [
        ...buildProfileItems(),
        SEPARATOR,
        startAllItem,
        stopAllItem,
        SEPARATOR,
        settingsItem,
        logItem,
        SEPARATOR,
        quitItem,
      ],
    };
  }

  const systray = new SysTray({
    menu: buildMenu(),
    debug: false,
    copyDir: true,
  });

  // Refresh the menu whenever a profile's state changes.
  manager.onChange = () => {
    void systray.sendAction({ type: "update-menu", menu: buildMenu() });
  };

  systray.onClick((action: { item?: unknown }) => {
    const item = action.item as { click?: () => void } | undefined;
    if (item && typeof item.click === "function") item.click();
  });

  await systray.ready();
  console.log(
    `[local-bridge] tray running — ${config.profiles.length} profile(s)\n` +
      `  Config: ${configPath()}`,
  );

  // Auto-start profiles
  manager.startAutoStart(config.profiles);

  return await new Promise<number>((resolve) => {
    systray.onExit(() => resolve(0));
  });
}

// ── util ───────────────────────────────────────────────────────────

function openPath(target: string): void {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const plat = process.platform;
  try {
    if (plat === "win32") {
      const child = spawn("cmd", ["/d", "/s", "/c", "start", "", target], {
        stdio: "ignore", detached: true, windowsHide: true,
      });
      child.on("error", () => {
        try { spawn("notepad", [target], { stdio: "ignore", detached: true }).unref(); } catch {}
      });
      child.unref();
      return;
    }
    const cmd = plat === "darwin" ? "open" : "xdg-open";
    spawn(cmd, [target], { stdio: "ignore", detached: true }).unref();
  } catch {}
}
