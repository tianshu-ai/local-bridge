// `tsbridge update` — check npm for a newer @tianshu-ai/local-bridge and
// optionally self-update the global install.
//
// Check-only by default; pass --yes to actually run the install. Uses
// the npm registry JSON API (no auth) for the check, and `npm i -g` for
// the apply so it works regardless of how the CLI was installed.

import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const PKG = "@tianshu-ai/local-bridge";
const REGISTRY = "https://registry.npmjs.org";

/** Installed version, read from this package's own package.json. */
export function installedVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // dist/update.js → ../package.json
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Fetch the latest published version + dist-tags from npm. */
async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(`${REGISTRY}/${encodeURIComponent(PKG).replace("%40", "@")}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { version?: string };
    return json.version ?? null;
  } catch {
    return null;
  }
}

/** Semver-ish compare: returns true if `remote` is strictly newer than
 *  `local`. Handles plain x.y.z; prerelease tags compare lexically as a
 *  best-effort tiebreak. */
function isNewer(remote: string, local: string): boolean {
  const parse = (v: string) => {
    const [core, pre] = v.split("-", 2);
    const nums = core.split(".").map((n) => parseInt(n, 10) || 0);
    return { nums, pre: pre ?? "" };
  };
  const a = parse(remote);
  const b = parse(local);
  for (let i = 0; i < 3; i++) {
    const x = a.nums[i] ?? 0;
    const y = b.nums[i] ?? 0;
    if (x !== y) return x > y;
  }
  // equal core: a release (no pre) beats a prerelease; else lexical
  if (a.pre === b.pre) return false;
  if (!a.pre) return true;
  if (!b.pre) return false;
  return a.pre > b.pre;
}

function runNpmInstall(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["install", "-g", `${PKG}@latest`], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

/** Run the update subcommand. `apply` = actually install the new version. */
export async function runUpdate(apply: boolean): Promise<number> {
  const local = installedVersion();
  process.stdout.write(`[tsbridge] installed: v${local}\n`);
  process.stdout.write(`[tsbridge] checking ${REGISTRY} for a newer ${PKG}…\n`);
  const latest = await fetchLatest();
  if (!latest) {
    process.stderr.write("[tsbridge] could not reach the npm registry.\n");
    return 1;
  }
  if (!isNewer(latest, local)) {
    process.stdout.write(`[tsbridge] up to date (latest is v${latest}).\n`);
    return 0;
  }
  process.stdout.write(`[tsbridge] a newer version is available: v${latest}\n`);
  if (!apply) {
    process.stdout.write(
      `[tsbridge] to update, run:\n    npm i -g ${PKG}@latest\n  or:\n    tsbridge update --yes\n`,
    );
    return 0;
  }
  process.stdout.write(`[tsbridge] updating v${local} → v${latest}…\n`);
  const code = await runNpmInstall();
  if (code === 0) {
    process.stdout.write(`[tsbridge] updated to v${latest}. Restart any running bridge.\n`);
  } else {
    process.stderr.write(
      `[tsbridge] update failed (npm exit ${code}). Try manually: npm i -g ${PKG}@latest\n` +
        `  (a permission error usually means you need sudo, or a Node version manager's global dir.)\n`,
    );
  }
  return code;
}
