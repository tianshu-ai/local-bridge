// `tsbridge update` — self-update the global @tianshu-ai/local-bridge
// install. Behaviour mirrors `tianshu update` for a consistent CLI:
//
//   tsbridge update            → check + install if newer (default: install)
//   tsbridge update --check    → just compare; exit 1 if an update exists
//   tsbridge update --dry-run  → print the npm command, don't run it
//   tsbridge update --tag next → target a non-`latest` dist-tag
//
// Exit codes:
//   0  → up to date, OR update succeeded, OR --check found nothing
//   1  → --check found an available update (script-friendly signal)
//   2  → error (network, npm install failed, git-checkout, …)

import { createRequire } from "node:module";
import { spawn } from "node:child_process";

export const PACKAGE_NAME = "@tianshu-ai/local-bridge";
const REGISTRY = "https://registry.npmjs.org";

export interface UpdateCmdOpts {
  /** Just check; don't install. */
  check?: boolean;
  /** npm dist-tag to target. Defaults to "latest". */
  tag?: string;
  /** Print the command we'd run, but don't run it. */
  dryRun?: boolean;
}

/** Installed version, read from this package's own package.json. */
export function installedVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function fetchDistTag(tag: string): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const url = `${REGISTRY}/${PACKAGE_NAME.replace("/", "%2f")}/${encodeURIComponent(tag)}`;
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = (await res.json()) as { version?: string };
    if (!json.version) return { ok: false, error: "no version in registry response" };
    return { ok: true, version: json.version };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function runNpmInstall(target: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["install", "-g", target], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

/** `tsbridge update [--check] [--tag <name>] [--dry-run]`. */
export async function runUpdate(opts: UpdateCmdOpts = {}): Promise<number> {
  const tag = opts.tag ?? "latest";
  const current = installedVersion();
  console.log(`Current version: ${current}`);

  const remote = await fetchDistTag(tag);
  if (!remote.ok) {
    console.error(`Couldn't reach npm registry: ${remote.error}`);
    console.error("Check your network / proxy and retry. If you're offline, skip the update.");
    return 2;
  }
  console.log(`Latest on \`${tag}\`: ${remote.version}`);

  if (current === remote.version) {
    console.log("Already up to date.");
    return 0;
  }

  if (opts.check) {
    console.log(`Update available: ${current} → ${remote.version}. Run \`tsbridge update\` to install.`);
    return 1;
  }

  const target = `${PACKAGE_NAME}@${remote.version}`;
  const cmd = `npm install -g ${target}`;
  if (opts.dryRun) {
    console.log(`Would run: ${cmd}`);
    return 0;
  }

  console.log(`Installing ${remote.version}…`);
  const code = await runNpmInstall(target);
  if (code === 0) {
    console.log(`Updated to ${remote.version}. Restart any running bridge (tsbridge --server …).`);
    return 0;
  }
  console.error(
    `npm install failed (exit ${code}). Try manually: ${cmd}\n` +
      "  A permission error usually means you need sudo, or a Node version manager's global dir.",
  );
  return 2;
}
