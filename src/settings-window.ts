// A native settings window for the tray, per platform, using each OS's
// own GUI toolkit — no bundled runtime, no extra install (the same
// philosophy as the macOS Swift menu-bar app).
//
//   Windows → PowerShell + System.Windows.Forms (ships with Windows)
//   macOS   → AppleScript dialogs (osascript, ships with macOS)
//   Linux   → fall back to opening the JSON in the default editor
//
// The window reads the current config.json, lets the user edit the same
// fields the Swift app exposes (server / token / browser+engine+headless
// / shell / device), and writes config.json back on Save. Runs the GUI
// as a detached child so it doesn't block the tray.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SettingsFields {
  server: string;
  token: string;
  browser: boolean;
  engine: "own" | "stealth";
  headless: boolean;
  shell: boolean;
  device: string;
}

/**
 * Open a native settings window. Best-effort, non-blocking. On success
 * the GUI writes the edited config to `configPath` itself; the caller
 * can re-read config after the window closes (or just on next Start).
 *
 * Returns true if a native window was launched, false if we fell back
 * to opening the raw file (Linux / unsupported).
 */
export function openSettingsWindow(
  configPath: string,
  current: SettingsFields,
): boolean {
  if (process.platform === "win32") {
    return openWindowsForm(configPath, current);
  }
  if (process.platform === "darwin") {
    return openMacDialogs(configPath, current);
  }
  return false; // Linux: caller opens the file instead
}

// ─── Windows: PowerShell + WinForms ─────────────────────────────────

function openWindowsForm(configPath: string, cur: SettingsFields): boolean {
  const scriptPath = path.join(os.tmpdir(), `tsbridge-settings-${process.pid}.ps1`);
  const ps = renderWindowsPs1(configPath, cur);
  try {
    fs.writeFileSync(scriptPath, ps, "utf8");
  } catch {
    return false;
  }
  try {
    // -STA is required for WinForms; -WindowStyle Hidden hides the PS
    // console so only the form shows.
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-STA",
        "-WindowStyle",
        "Hidden",
        "-File",
        scriptPath,
      ],
      { stdio: "ignore", detached: true, windowsHide: true },
    );
    // Swallow spawn errors (e.g. powershell missing) so they don't crash
    // the tray process; the caller falls back to opening the raw file.
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** PowerShell-single-quote-escape a JS string. */
function psq(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function renderWindowsPs1(configPath: string, cur: SettingsFields): string {
  // The script builds a WinForms dialog, prefilled with current values,
  // and on OK writes config.json (merging into whatever is already there
  // so we don't clobber unknown keys).
  const cfgPathLit = psq(configPath);
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$configPath = ${cfgPathLit}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Tianshu Bridge — Settings'
$form.Size = New-Object System.Drawing.Size(460, 380)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false

function New-Label($text, $y) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text
  $l.Location = New-Object System.Drawing.Point(16, $y)
  $l.Size = New-Object System.Drawing.Size(120, 20)
  $form.Controls.Add($l)
  return $l
}

# Server
New-Label 'Server URL' 20 | Out-Null
$server = New-Object System.Windows.Forms.TextBox
$server.Location = New-Object System.Drawing.Point(140, 18)
$server.Size = New-Object System.Drawing.Size(290, 20)
$server.Text = ${psq(cur.server)}
$form.Controls.Add($server)

# Token
New-Label 'Token' 52 | Out-Null
$token = New-Object System.Windows.Forms.TextBox
$token.Location = New-Object System.Drawing.Point(140, 50)
$token.Size = New-Object System.Drawing.Size(290, 20)
$token.Text = ${psq(cur.token)}
$form.Controls.Add($token)

# Device
New-Label 'Device (optional)' 84 | Out-Null
$device = New-Object System.Windows.Forms.TextBox
$device.Location = New-Object System.Drawing.Point(140, 82)
$device.Size = New-Object System.Drawing.Size(290, 20)
$device.Text = ${psq(cur.device)}
$form.Controls.Add($device)

# Browser enabled
$browser = New-Object System.Windows.Forms.CheckBox
$browser.Text = 'Expose browser tools'
$browser.Location = New-Object System.Drawing.Point(140, 116)
$browser.Size = New-Object System.Drawing.Size(290, 20)
$browser.Checked = $${cur.browser ? "true" : "false"}
$form.Controls.Add($browser)

# Engine
New-Label 'Browser engine' 148 | Out-Null
$engine = New-Object System.Windows.Forms.ComboBox
$engine.Location = New-Object System.Drawing.Point(140, 146)
$engine.Size = New-Object System.Drawing.Size(150, 20)
$engine.DropDownStyle = 'DropDownList'
[void]$engine.Items.Add('own')
[void]$engine.Items.Add('stealth')
$engine.SelectedItem = ${psq(cur.engine)}
$form.Controls.Add($engine)

# Headless
$headless = New-Object System.Windows.Forms.CheckBox
$headless.Text = 'Headless (no browser window)'
$headless.Location = New-Object System.Drawing.Point(140, 178)
$headless.Size = New-Object System.Drawing.Size(290, 20)
$headless.Checked = $${cur.headless ? "true" : "false"}
$form.Controls.Add($headless)

# Shell
$shell = New-Object System.Windows.Forms.CheckBox
$shell.Text = 'Expose shell (exec + file sync) — runs commands on this machine'
$shell.Location = New-Object System.Drawing.Point(140, 210)
$shell.Size = New-Object System.Drawing.Size(300, 34)
$shell.Checked = $${cur.shell ? "true" : "false"}
$form.Controls.Add($shell)

# Buttons
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Save'
$ok.Location = New-Object System.Drawing.Point(250, 300)
$ok.Size = New-Object System.Drawing.Size(85, 28)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($ok)
$form.AcceptButton = $ok

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object System.Drawing.Point(345, 300)
$cancel.Size = New-Object System.Drawing.Size(85, 28)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancel)
$form.CancelButton = $cancel

$result = $form.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  # Merge into existing config so unknown keys survive.
  $cfg = @{}
  if (Test-Path $configPath) {
    try { $cfg = Get-Content $configPath -Raw | ConvertFrom-Json -AsHashtable } catch { $cfg = @{} }
  }
  if ($null -eq $cfg) { $cfg = @{} }
  $cfg['server']   = $server.Text
  $cfg['token']    = $token.Text
  $cfg['device']   = $device.Text
  $cfg['browser']  = [bool]$browser.Checked
  $cfg['engine']   = [string]$engine.SelectedItem
  $cfg['headless'] = [bool]$headless.Checked
  $cfg['shell']    = [bool]$shell.Checked
  $dir = Split-Path -Parent $configPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  ($cfg | ConvertTo-Json -Depth 10) | Set-Content -Path $configPath -Encoding UTF8
}
`;
}

// ─── macOS: AppleScript dialogs ─────────────────────────────────────
//
// A lightweight multi-field settings flow via osascript. Not as slick as
// the Swift app's form, but keeps parity if someone runs the CLI tray on
// macOS instead of the .app. Presents fields sequentially.

function openMacDialogs(configPath: string, cur: SettingsFields): boolean {
  // Keep it simple + non-blocking: one AppleScript that chains dialogs
  // and writes the JSON via `defaults`-free plain file write in the
  // script tail. We build the whole thing as one osascript -e program.
  const script = renderMacOsa(configPath, cur);
  try {
    const child = spawn("osascript", ["-e", script], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** AppleScript-double-quote-escape. */
function asq(s: string): string {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderMacOsa(configPath: string, cur: SettingsFields): string {
  // Prompt for server + token + engine + toggles, then shell out to a
  // tiny writer. Fields are gathered with `display dialog`; booleans via
  // `choose from list`. This is intentionally minimal.
  const p = asq(configPath);
  return [
    `set cfgPath to ${p}`,
    `set srv to text returned of (display dialog "Server URL" default answer ${asq(cur.server)})`,
    `set tok to text returned of (display dialog "Token (blank for none)" default answer ${asq(cur.token)})`,
    `set dev to text returned of (display dialog "Device (optional)" default answer ${asq(cur.device)})`,
    `set eng to (choose from list {"own", "stealth"} default items {${asq(cur.engine)}} with prompt "Browser engine")`,
    `if eng is false then return`,
    `set engv to item 1 of eng`,
    `set opts to (choose from list {"browser", "headless", "shell"} default items {${[
      cur.browser ? '"browser"' : "",
      cur.headless ? '"headless"' : "",
      cur.shell ? '"shell"' : "",
    ]
      .filter(Boolean)
      .join(", ")}} with prompt "Enable which options?" with multiple selections allowed)`,
    `if opts is false then set opts to {}`,
    `set br to "false"`,
    `set hl to "false"`,
    `set sh to "false"`,
    `repeat with o in opts`,
    `  if (o as string) is "browser" then set br to "true"`,
    `  if (o as string) is "headless" then set hl to "true"`,
    `  if (o as string) is "shell" then set sh to "true"`,
    `end repeat`,
    `set json to "{\\"server\\":\\"" & srv & "\\",\\"token\\":\\"" & tok & "\\",\\"device\\":\\"" & dev & "\\",\\"browser\\":" & br & ",\\"engine\\":\\"" & engv & "\\",\\"headless\\":" & hl & ",\\"shell\\":" & sh & "}"`,
    `do shell script "mkdir -p " & quoted form of (do shell script "dirname " & quoted form of cfgPath)`,
    `do shell script "cat > " & quoted form of cfgPath & " <<'TSEOF'\n" & json & "\nTSEOF"`,
  ].join("\n");
}
