// `tsbridge install-app` — build + install the macOS menu-bar app.
//
// Compiles a tiny native AppKit menu-bar app (swiftc, no Electron) that
// wraps this CLI: a menu-bar icon with Start/Stop + Settings (server /
// token / browser engine / headless). The Swift source ships in the npm
// package (app/TianshuBridge.swift); we assemble the .app bundle and
// compile it on the user's machine.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_NAME = "Tianshu Bridge";
const BUNDLE_ID = "ai.tianshu.local-bridge";

function findSwiftSource(): string | null {
  // dist/install-app.js → ../app/TianshuBridge.swift (shipped in the package)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "app", "TianshuBridge.swift"),
    path.join(here, "app", "TianshuBridge.swift"),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export interface InstallAppOpts {
  /** Install destination dir. Default: ~/Applications. */
  dest?: string;
  /** Launch the app after install. */
  run?: boolean;
}

export function installApp(opts: InstallAppOpts = {}): number {
  if (process.platform !== "darwin") {
    console.error("error: the menu-bar app is macOS-only.");
    return 1;
  }
  const swiftc = spawnSync("swiftc", ["--version"], { stdio: "ignore" });
  if (swiftc.status !== 0) {
    console.error("error: swiftc not found. Install Xcode command line tools:");
    console.error("  xcode-select --install");
    return 1;
  }
  const src = findSwiftSource();
  if (!src) {
    console.error("error: bundled Swift source not found in the package.");
    return 1;
  }

  const dest = opts.dest || path.join(os.homedir(), "Applications");
  const appDir = path.join(dest, `${APP_NAME}.app`);
  const macosDir = path.join(appDir, "Contents", "MacOS");
  const resDir = path.join(appDir, "Contents", "Resources");

  console.log(`→ Building ${APP_NAME}.app …`);
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>TianshuBridge</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
  fs.writeFileSync(path.join(appDir, "Contents", "Info.plist"), plist);

  console.log("→ Compiling Swift (menu-bar app) …");
  const build = spawnSync(
    "swiftc",
    ["-O", "-o", path.join(macosDir, "TianshuBridge"), src, "-framework", "AppKit", "-framework", "Foundation"],
    { stdio: "inherit" },
  );
  if (build.status !== 0) {
    console.error("error: swiftc build failed.");
    return 1;
  }

  // Clear any quarantine attribute so `open` / Gatekeeper doesn't
  // silently refuse to launch the freshly-written bundle.
  spawnSync("xattr", ["-dr", "com.apple.quarantine", appDir], { stdio: "ignore" });
  // Ad-hoc sign so Gatekeeper allows a locally-built app.
  spawnSync("codesign", ["--force", "--deep", "--sign", "-", appDir], { stdio: "ignore" });

  console.log(`✓ Installed: ${appDir}`);
  console.log("");
  console.log(`It lives in the menu bar (bolt icon). Click it → Settings to set your`);
  console.log(`server URL + token, then Start. First launch: right-click the app → Open`);
  console.log(`to bypass Gatekeeper (unsigned local build).`);

  if (opts.run) {
    console.log("→ Launching …");
    spawnSync("open", [appDir], { stdio: "ignore" });
  }
  return 0;
}
