// Tianshu Local Bridge — macOS menu-bar app.
//
// A thin GUI wrapper around the `tsbridge` CLI: lives only in the menu
// bar (LSUIElement), lets you set the server URL / token / browser
// engine / headless, and Start/Stop the bridge. It spawns `tsbridge`
// with the chosen flags and shows connection status. Config persists to
// ~/.tianshu-bridge/config.json.
//
// Built on demand by install-app.sh via `swiftc` — no external deps.

import AppKit
import Foundation

// ─── config ─────────────────────────────────────────────────────────

struct Config: Codable {
    var server: String = "ws://localhost:3110/ws"
    var token: String = ""
    var engine: String = "own"        // "own" | "stealth"
    var headless: Bool = false
    var device: String = ""            // empty → hostname

    static var path: URL {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".tianshu-bridge", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("config.json")
    }

    static func load() -> Config {
        guard let data = try? Data(contentsOf: path),
              let cfg = try? JSONDecoder().decode(Config.self, from: data) else {
            return Config()
        }
        return cfg
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            try? data.write(to: Config.path)
        }
    }
}

// ─── locating tsbridge / node ────────────────────────────────────────

// GUI apps don't inherit the shell PATH, and tsbridge often lives under
// a Node version manager (nvm/fnm). Resolve a usable command + PATH.
func resolveTsbridge() -> (cmd: String, env: [String: String])? {
    let fm = FileManager.default
    let home = fm.homeDirectoryForCurrentUser.path
    var candidates: [String] = [
        "/usr/local/bin/tsbridge",
        "/opt/homebrew/bin/tsbridge",
    ]
    // nvm: newest version dir that has tsbridge
    let nvm = "\(home)/.nvm/versions/node"
    if let vers = try? fm.contentsOfDirectory(atPath: nvm) {
        for v in vers.sorted(by: >) {
            candidates.append("\(nvm)/\(v)/bin/tsbridge")
        }
    }
    for c in candidates where fm.isExecutableFile(atPath: c) {
        // Prepend the bin dir to PATH so the spawned tsbridge finds
        // `node` and `npx` (needed for @playwright/mcp / cloakbrowser).
        let bin = (c as NSString).deletingLastPathComponent
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "\(bin):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
        return (c, env)
    }
    return nil
}

// ─── the bridge process ──────────────────────────────────────────────

final class Bridge {
    private var proc: Process?
    var isRunning: Bool { proc?.isRunning ?? false }
    var onStateChange: (() -> Void)?

    func start(_ cfg: Config) {
        stop()
        guard let (cmd, env) = resolveTsbridge() else {
            notify("tsbridge not found", "Install it: npm i -g @tianshu-ai/local-bridge")
            return
        }
        var args = ["--server", cfg.server]
        if !cfg.token.isEmpty { args += ["--token", cfg.token] }
        if cfg.engine == "stealth" { args += ["--browser-engine", "stealth"] }
        if cfg.headless { args += ["--headless"] }
        if !cfg.device.isEmpty { args += ["--device", cfg.device] }

        let p = Process()
        p.executableURL = URL(fileURLWithPath: cmd)
        p.arguments = args
        p.environment = env
        // Log to ~/.tianshu-bridge/bridge.log for troubleshooting.
        let logURL = Config.path.deletingLastPathComponent().appendingPathComponent("bridge.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let fh = try? FileHandle(forWritingTo: logURL) {
            p.standardOutput = fh
            p.standardError = fh
        }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.onStateChange?() }
        }
        do {
            try p.run()
            proc = p
        } catch {
            notify("Failed to start bridge", error.localizedDescription)
        }
        onStateChange?()
    }

    func stop() {
        if let p = proc, p.isRunning { p.terminate() }
        proc = nil
    }

    private func notify(_ title: String, _ body: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = body
        a.runModal()
    }
}

// ─── menu-bar controller ─────────────────────────────────────────────

final class AppController: NSObject, NSApplicationDelegate {
    // Created in applicationDidFinishLaunching (not at init) so the app
    // is fully up before we claim a status-bar slot.
    var statusItem: NSStatusItem!
    let bridge = Bridge()
    var cfg = Config.load()
    var configWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateIcon()
        bridge.onStateChange = { [weak self] in
            self?.updateIcon()
            self?.rebuildMenu()
        }
        rebuildMenu()
    }

    func updateIcon() {
        guard let btn = statusItem.button else { return }
        let on = bridge.isRunning
        let name = on ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle"
        if let img = NSImage(systemSymbolName: name, accessibilityDescription: "Tianshu Bridge") {
            img.isTemplate = true
            btn.image = img
            btn.title = ""
        } else {
            // SF Symbol unavailable → always-visible text fallback.
            btn.image = nil
            btn.title = on ? "⚡●" : "⚡"
        }
        btn.toolTip = on ? "Tianshu Bridge: connected" : "Tianshu Bridge: stopped"
    }

    func rebuildMenu() {
        let menu = NSMenu()
        let status = bridge.isRunning ? "● Connected" : "○ Stopped"
        let statusMI = NSMenuItem(title: status, action: nil, keyEquivalent: "")
        statusMI.isEnabled = false
        menu.addItem(statusMI)
        menu.addItem(NSMenuItem(title: "Server: \(cfg.server)", action: nil, keyEquivalent: ""))
        let eng = cfg.engine == "stealth" ? "stealth" : "own"
        menu.addItem(NSMenuItem(title: "Browser: \(eng)\(cfg.headless ? " (headless)" : "")",
                                action: nil, keyEquivalent: ""))
        menu.addItem(.separator())

        if bridge.isRunning {
            menu.addItem(withTitle: "Stop", action: #selector(stop), keyEquivalent: "s").target = self
        } else {
            menu.addItem(withTitle: "Start", action: #selector(start), keyEquivalent: "s").target = self
        }
        menu.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",").target = self
        menu.addItem(withTitle: "Open Log", action: #selector(openLog), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(quit), keyEquivalent: "q").target = self
        statusItem.menu = menu
    }

    @objc func start() { bridge.start(cfg) }
    @objc func stop() { bridge.stop(); updateIcon(); rebuildMenu() }
    @objc func openLog() {
        let log = Config.path.deletingLastPathComponent().appendingPathComponent("bridge.log")
        NSWorkspace.shared.open(log)
    }
    @objc func quit() { bridge.stop(); NSApp.terminate(nil) }

    // ── settings window (simple form) ──
    @objc func openSettings() {
        if configWindow == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 260),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "Tianshu Bridge Settings"
            w.center()
            w.contentView = makeSettingsView()
            w.isReleasedWhenClosed = false
            configWindow = w
        }
        NSApp.activate(ignoringOtherApps: true)
        configWindow?.makeKeyAndOrderFront(nil)
    }

    private var serverField: NSTextField!
    private var tokenField: NSTextField!
    private var enginePopup: NSPopUpButton!
    private var headlessCheck: NSButton!

    private func makeSettingsView() -> NSView {
        let v = NSView(frame: NSRect(x: 0, y: 0, width: 380, height: 260))
        func label(_ s: String, _ y: CGFloat) -> NSTextField {
            let l = NSTextField(labelWithString: s); l.frame = NSRect(x: 16, y: y, width: 90, height: 20); return l
        }
        v.addSubview(label("Server", 210))
        serverField = NSTextField(frame: NSRect(x: 110, y: 208, width: 250, height: 24))
        serverField.stringValue = cfg.server; v.addSubview(serverField)

        v.addSubview(label("Token", 172))
        tokenField = NSTextField(frame: NSRect(x: 110, y: 170, width: 250, height: 24))
        tokenField.stringValue = cfg.token; v.addSubview(tokenField)

        v.addSubview(label("Browser", 134))
        enginePopup = NSPopUpButton(frame: NSRect(x: 110, y: 130, width: 250, height: 26))
        enginePopup.addItems(withTitles: ["own (your Chrome)", "stealth (CloakBrowser)"])
        enginePopup.selectItem(at: cfg.engine == "stealth" ? 1 : 0)
        v.addSubview(enginePopup)

        headlessCheck = NSButton(checkboxWithTitle: "Headless (no window)", target: nil, action: nil)
        headlessCheck.frame = NSRect(x: 110, y: 98, width: 250, height: 20)
        headlessCheck.state = cfg.headless ? .on : .off
        v.addSubview(headlessCheck)

        let save = NSButton(title: "Save & Restart", target: self, action: #selector(saveSettings))
        save.frame = NSRect(x: 200, y: 20, width: 160, height: 32)
        save.bezelStyle = .rounded
        v.addSubview(save)
        return v
    }

    @objc func saveSettings() {
        cfg.server = serverField.stringValue.trimmingCharacters(in: .whitespaces)
        cfg.token = tokenField.stringValue.trimmingCharacters(in: .whitespaces)
        cfg.engine = enginePopup.indexOfSelectedItem == 1 ? "stealth" : "own"
        cfg.headless = headlessCheck.state == .on
        cfg.save()
        configWindow?.close()
        rebuildMenu()
        if bridge.isRunning { bridge.start(cfg) } // restart with new config
    }
}

// ─── main ────────────────────────────────────────────────────────────

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu-bar only, no Dock icon
let controller = AppController()
app.delegate = controller
app.run()
