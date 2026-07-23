# Changelog

## [0.8.1](https://github.com/tianshu-ai/local-bridge/compare/v0.8.0...v0.8.1) (2026-07-23)


### Bug Fixes

* **tray:** make 'Edit settings' open reliably on Windows ([#25](https://github.com/tianshu-ai/local-bridge/issues/25)) ([250007b](https://github.com/tianshu-ai/local-bridge/commit/250007bb4c3745b159fe158c828db3833556dc7f))

## [0.8.0](https://github.com/tianshu-ai/local-bridge/compare/v0.7.4...v0.8.0) (2026-07-23)


### Features

* cross-platform system-tray app via systray2 (Windows/macOS/Linux) ([#23](https://github.com/tianshu-ai/local-bridge/issues/23)) ([b617585](https://github.com/tianshu-ai/local-bridge/commit/b61758517ce140b1a19de56945dcb08eecbee9be))

## [0.7.4](https://github.com/tianshu-ai/local-bridge/compare/v0.7.3...v0.7.4) (2026-07-22)


### Chores

* release 0.7.4 ([99b38b7](https://github.com/tianshu-ai/local-bridge/commit/99b38b7378e6184fc999d7e4539718154c9e021f))

## [0.7.3](https://github.com/tianshu-ai/local-bridge/compare/v0.7.2...v0.7.3) (2026-07-22)


### Bug Fixes

* heartbeat re-registers instead of WS ping (recover tools after server restart) ([#19](https://github.com/tianshu-ai/local-bridge/issues/19)) ([5eca50c](https://github.com/tianshu-ai/local-bridge/commit/5eca50c2db07a01e08ea2c5d3ed9fac99803af90))

## [0.7.2](https://github.com/tianshu-ai/local-bridge/compare/v0.7.1...v0.7.2) (2026-07-22)


### Bug Fixes

* faster reconnect + diagnostic logging for drops ([#17](https://github.com/tianshu-ai/local-bridge/issues/17)) ([83f97eb](https://github.com/tianshu-ai/local-bridge/commit/83f97ebf0cf9e67981f7398be19567cd9319125f))

## [0.7.1](https://github.com/tianshu-ai/local-bridge/compare/v0.7.0...v0.7.1) (2026-07-22)


### Bug Fixes

* detect dead WS links via heartbeat + reconnect ([#15](https://github.com/tianshu-ai/local-bridge/issues/15)) ([a67b0c9](https://github.com/tianshu-ai/local-bridge/commit/a67b0c9c00712e4baa222befd95e4cc89c2ff4b6))

## [0.7.0](https://github.com/tianshu-ai/local-bridge/compare/v0.6.2...v0.7.0) (2026-07-21)


### Features

* Browser as a top-level optional capability in the app ([#13](https://github.com/tianshu-ai/local-bridge/issues/13)) ([13f2975](https://github.com/tianshu-ai/local-bridge/commit/13f2975b1547418dafbe7f0099fa86f73b6d19f5))

## [0.6.2](https://github.com/tianshu-ai/local-bridge/compare/v0.6.1...v0.6.2) (2026-07-21)


### Bug Fixes

* add Shell toggle to the menu-bar app settings ([#11](https://github.com/tianshu-ai/local-bridge/issues/11)) ([041ab5f](https://github.com/tianshu-ai/local-bridge/commit/041ab5f03d1e223de45f00743007d6043b74f072))

## [0.6.1](https://github.com/tianshu-ai/local-bridge/compare/v0.6.0...v0.6.1) (2026-07-21)


### Bug Fixes

* make shell opt-in (--shell), off by default ([#9](https://github.com/tianshu-ai/local-bridge/issues/9)) ([5e9b854](https://github.com/tianshu-ai/local-bridge/commit/5e9b854774385cdca580133302272904a9ce3426))

## [0.6.0](https://github.com/tianshu-ai/local-bridge/compare/v0.5.0...v0.6.0) (2026-07-20)


### Features

* native shell exec + sync_up/sync_down tools (openshell parity) ([#7](https://github.com/tianshu-ai/local-bridge/issues/7)) ([90d5d4b](https://github.com/tianshu-ai/local-bridge/commit/90d5d4b0521d9576642cea4c442c25dc78de189d))

## [0.5.0](https://github.com/tianshu-ai/local-bridge/compare/v0.4.1...v0.5.0) (2026-07-19)


### Features

* 'tsbridge install-app' subcommand builds the macOS menu-bar app ([5eafd11](https://github.com/tianshu-ai/local-bridge/commit/5eafd11bc1734a4268e284ef5bc5d7db00465355))
* **app:** 'Paste from tianshu' button in Settings ([23a4e2a](https://github.com/tianshu-ai/local-bridge/commit/23a4e2a5d7fab1ad430767fe7cb4f6f7943e6adf))
* macOS menu-bar app (build via install-app.sh) wrapping the CLI ([8b3c56a](https://github.com/tianshu-ai/local-bridge/commit/8b3c56a18cd834b61409d8b84e32cb333c857bca))
* own engine uses full @playwright/mcp toolset (parity with stealth) ([e3df918](https://github.com/tianshu-ai/local-bridge/commit/e3df9185993f168d7c16e2567e90359fd746bf3c))


### Bug Fixes

* **app:** reliable menu-bar icon + clear quarantine on install ([2ef67e5](https://github.com/tianshu-ai/local-bridge/commit/2ef67e510feb9ca65e8b49a8123cbe77edc53a6c))
* pin browser MCP output dir to ~/.tianshu-bridge (real root cause) ([04ecef6](https://github.com/tianshu-ai/local-bridge/commit/04ecef6fbbb4f3363e283e444d00e4335c9e3a44))
* set HOME for the browser MCP child (menu-bar app launch) ([fa2c86a](https://github.com/tianshu-ai/local-bridge/commit/fa2c86afc3f71a1f40743407680c71254d3dce73))
* stealth browser respects --headless (correct env var) ([fc8bfc5](https://github.com/tianshu-ai/local-bridge/commit/fc8bfc56601326ee9cf685cf0349dc5e8337d175))


### Refactor

* align 'tsbridge update' with 'tianshu update' semantics ([25941e9](https://github.com/tianshu-ai/local-bridge/commit/25941e928a3928f19254d134c6045ee7012ae65c))

## [0.4.1](https://github.com/tianshu-ai/local-bridge/compare/v0.4.0...v0.4.1) (2026-07-19)


### Refactor

* drop the echo connectivity tool ([1715871](https://github.com/tianshu-ai/local-bridge/commit/17158716b881ed42dd0f06876a00c040aa86b2a8))

## [0.4.0](https://github.com/tianshu-ai/local-bridge/compare/v0.3.0...v0.4.0) (2026-07-19)


### Features

* 'tsbridge update' command to check + self-update ([811ea54](https://github.com/tianshu-ai/local-bridge/commit/811ea542d8cc7f6c01ccba34f3712254950478a4))


### Documentation

* document tsbridge update/version commands ([3a2ff38](https://github.com/tianshu-ai/local-bridge/commit/3a2ff388edc9271553930b804e8a41c4c6da1169))

## [0.3.0](https://github.com/tianshu-ai/local-bridge/compare/v0.2.1...v0.3.0) (2026-07-19)


### Features

* add short 'tsbridge' command + promote global install ([49cc688](https://github.com/tianshu-ai/local-bridge/commit/49cc688f68eabf93631260bd4f132079cea8dcea))

## [0.2.1](https://github.com/tianshu-ai/local-bridge/compare/v0.2.0...v0.2.1) (2026-07-19)


### Bug Fixes

* add repository/homepage/bugs metadata for npm provenance ([fb09ba4](https://github.com/tianshu-ai/local-bridge/commit/fb09ba476233c99ef15c576e0ed2c0d89bb882f1))

## [0.2.0](https://github.com/tianshu-ai/local-bridge/compare/v0.1.0...v0.2.0) (2026-07-19)


### Features

* browser_screenshot returns PNG bytes as an MCP image block ([65a652a](https://github.com/tianshu-ai/local-bridge/commit/65a652aa8d1848460e54ea8669611030846e5f17))
* stealth browser engine via cloakbrowser-mcp (full Playwright-MCP toolset) ([8cb59c1](https://github.com/tianshu-ai/local-bridge/commit/8cb59c1baedfc474e7c735dd707b6cf1b031033e))
* tianshu-bridge — local reverse-MCP client (echo + browser tools) ([2eaeeec](https://github.com/tianshu-ai/local-bridge/commit/2eaeeec732f69b331e03c00cd65f859e27c1a02d))
* use the user's own Chrome (CDP connect or system-Chrome launch), no download ([ae48076](https://github.com/tianshu-ai/local-bridge/commit/ae480768878b9f7abe398388d0eca41c4648f2b7))
