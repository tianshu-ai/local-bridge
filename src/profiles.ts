// Multi-profile configuration for the bridge.
//
// Backward-compatible: reads old single-server config.json and
// migrates it to profiles[] on save. Each profile has its own
// server/token/device/label and can be started/stopped independently.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BridgeProfile {
  /** Unique id (auto-generated UUID-like). */
  id: string;
  /** Human-readable name shown in tray/settings. */
  name: string;
  /** WebSocket URL, e.g. wss://host/ws */
  server: string;
  /** Auth token. */
  token: string;
  /** Device id sent to server. */
  device: string;
  /** Whether to auto-start this profile on launch. */
  autoStart: boolean;
  /** Enable browser tools. */
  browser: boolean;
  /** Browser engine: own | stealth */
  engine: "own" | "stealth";
  /** Run browser headless. */
  headless: boolean;
  /** Enable shell tools. */
  shell: boolean;
}

export interface MultiConfig {
  profiles: BridgeProfile[];
  /** Global defaults (used when profile doesn't override). */
  defaults?: {
    browser?: boolean;
    engine?: "own" | "stealth";
    headless?: boolean;
    shell?: boolean;
  };
}

// ── Legacy single-profile config (for migration) ───────────────────

interface LegacyConfig {
  server: string;
  token: string;
  browser: boolean;
  engine: "own" | "stealth";
  headless: boolean;
  shell: boolean;
  device: string;
}

// ── Paths ──────────────────────────────────────────────────────────

export function configDir(): string {
  const dir = path.join(os.homedir(), ".tianshu-bridge");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function logPath(profileId?: string): string {
  if (profileId) {
    return path.join(configDir(), `bridge-${profileId}.log`);
  }
  return path.join(configDir(), "bridge.log");
}

// ── Profile helpers ────────────────────────────────────────────────

function generateId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createProfile(partial: Partial<BridgeProfile> & { server: string }): BridgeProfile {
  return {
    id: partial.id ?? generateId(),
    name: partial.name ?? new URL(partial.server).hostname,
    server: partial.server,
    token: partial.token ?? "",
    device: partial.device ?? os.hostname() ?? "bridge",
    autoStart: partial.autoStart ?? true,
    browser: partial.browser ?? true,
    engine: partial.engine ?? "own",
    headless: partial.headless ?? false,
    shell: partial.shell ?? false,
  };
}

// ── Load / Save ────────────────────────────────────────────────────

export function loadConfig(): MultiConfig {
  const p = configPath();
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));

    // New format: has profiles[]
    if (Array.isArray(raw.profiles)) {
      return {
        profiles: raw.profiles.map((p: Partial<BridgeProfile>) =>
          createProfile({ server: p.server ?? "ws://localhost:3110/ws", ...p }),
        ),
        defaults: raw.defaults,
      };
    }

    // Legacy format: single server/token at top level → migrate
    const legacy = raw as Partial<LegacyConfig>;
    if (legacy.server) {
      const profile = createProfile({
        name: "Default",
        server: legacy.server,
        token: legacy.token ?? "",
        device: legacy.device ?? "",
        browser: legacy.browser ?? true,
        engine: legacy.engine ?? "own",
        headless: legacy.headless ?? false,
        shell: legacy.shell ?? false,
      });
      const config: MultiConfig = { profiles: [profile] };
      // Save migrated format
      saveConfig(config);
      return config;
    }
  } catch {
    /* no file or parse error */
  }

  // Default: empty profiles list
  return { profiles: [] };
}

export function saveConfig(config: MultiConfig): void {
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n");
}

export function ensureConfigFile(): string {
  const p = configPath();
  if (!fs.existsSync(p)) {
    saveConfig({ profiles: [] });
  }
  return p;
}

// ── Convenience ────────────────────────────────────────────────────

export function addProfile(config: MultiConfig, partial: Partial<BridgeProfile> & { server: string }): BridgeProfile {
  const profile = createProfile(partial);
  config.profiles.push(profile);
  saveConfig(config);
  return profile;
}

export function removeProfile(config: MultiConfig, id: string): boolean {
  const idx = config.profiles.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  config.profiles.splice(idx, 1);
  saveConfig(config);
  return true;
}

export function updateProfile(config: MultiConfig, id: string, patch: Partial<BridgeProfile>): boolean {
  const profile = config.profiles.find((p) => p.id === id);
  if (!profile) return false;
  Object.assign(profile, patch);
  saveConfig(config);
  return true;
}
