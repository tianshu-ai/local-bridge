// BridgeManager — manages multiple bridge child processes, one per profile.
//
// Each profile gets its own child process running `tsbridge --server ...`.
// The manager tracks state and provides start/stop per profile.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logPath, type BridgeProfile } from "./profiles.js";

export type ProfileState = "stopped" | "starting" | "running" | "error";

export interface ProfileStatus {
  id: string;
  name: string;
  state: ProfileState;
  server: string;
}

export class BridgeManager {
  private processes = new Map<string, ChildProcess>();
  private states = new Map<string, ProfileState>();
  onChange: (() => void) | null = null;

  getState(profileId: string): ProfileState {
    return this.states.get(profileId) ?? "stopped";
  }

  getAllStatus(profiles: BridgeProfile[]): ProfileStatus[] {
    return profiles.map((p) => ({
      id: p.id,
      name: p.name,
      state: this.getState(p.id),
      server: p.server,
    }));
  }

  isRunning(profileId: string): boolean {
    const proc = this.processes.get(profileId);
    return proc !== null && proc !== undefined && proc.exitCode === null && !proc.killed;
  }

  isAnyRunning(): boolean {
    for (const [id] of this.processes) {
      if (this.isRunning(id)) return true;
    }
    return false;
  }

  start(profile: BridgeProfile): void {
    if (this.isRunning(profile.id)) return;

    const here = path.dirname(fileURLToPath(import.meta.url));
    const entry = path.join(here, "index.js");
    const args = [entry, ...buildArgs(profile)];

    let out: number | "ignore" = "ignore";
    try {
      out = fs.openSync(logPath(profile.id), "a");
    } catch {
      out = "ignore";
    }

    this.setState(profile.id, "starting");
    const proc = spawn(process.execPath, args, {
      stdio: ["ignore", out, out],
      windowsHide: true,
    });

    proc.on("spawn", () => {
      this.setState(profile.id, "running");
    });

    proc.on("exit", (code) => {
      this.processes.delete(profile.id);
      this.setState(profile.id, code === 0 ? "stopped" : "error");
    });

    proc.on("error", () => {
      this.processes.delete(profile.id);
      this.setState(profile.id, "error");
    });

    this.processes.set(profile.id, proc);
  }

  stop(profileId: string): void {
    const proc = this.processes.get(profileId);
    if (proc && this.isRunning(profileId)) {
      proc.kill();
    }
    this.processes.delete(profileId);
    this.setState(profileId, "stopped");
  }

  stopAll(): void {
    for (const [id] of this.processes) {
      this.stop(id);
    }
  }

  /** Start all profiles marked autoStart. */
  startAutoStart(profiles: BridgeProfile[]): void {
    for (const p of profiles) {
      if (p.autoStart) this.start(p);
    }
  }

  private setState(profileId: string, state: ProfileState): void {
    this.states.set(profileId, state);
    this.onChange?.();
  }
}

function buildArgs(p: BridgeProfile): string[] {
  const args = ["--server", p.server];
  if (p.token) args.push("--token", p.token);
  if (p.device) args.push("--device", p.device);
  if (p.browser) {
    if (p.engine === "stealth") args.push("--browser-engine", "stealth");
    if (p.headless) args.push("--headless");
  } else {
    args.push("--no-browser");
  }
  if (p.shell) args.push("--shell");
  return args;
}
