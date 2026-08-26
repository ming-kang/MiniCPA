# Changelog

This file records MiniCPA npm releases beginning with 0.1.3. Earlier repository versions were not published to npm and are not maintained here.

## [Unreleased]

### Added

- `cpa start` now records every outcome as one line in `<cpa home>/logs/minicpa.log` (`start ok pid=…` or `start failed: …`, rotated at 1 MiB). This closes a blind spot in autostart: the Windows login launcher discards the process's output, and the failures that matter most at login — a missing `config.yaml`, a missing managed binary, a held lock — all happen before the CLIProxyAPI child exists, so they reached neither the terminal nor `cpa.log` / `cpa.err.log`. Successes are recorded too, so an empty log now means the launcher never fired rather than that it fired and worked.
- `cpa doctor` replays the last recorded start failure when autostart is in force, so a login that failed silently is diagnosable without waiting for another reboot.
- `cpa auto on` now prints a `Note:` when `config.yaml` or the managed binary is still missing, naming `cpa init` or `cpa update`. Registration still succeeds — enabling autostart before initializing is a legitimate order for scripted setups — but the gap no longer surfaces only at the next login.

### Changed

- macOS autostart inspection now fails closed: an entry present in `launchctl print-disabled` whose value MiniCPA does not recognize is reported as `disabled` instead of `on`. Both `true` and `disabled` count as disabled and both `false` and `enabled` as in force, so a rendering change in a future macOS release no longer silently reports a suppressed registration as working. An absent entry still means enabled, which is the normal state on a healthy Mac.
- Autostart inspection now reports `stale` instead of `disabled` when a registration is both diverging from what MiniCPA generates and disabled by the OS. A registration that does not match would not start MiniCPA even after being re-enabled, so repairing it is the more useful thing to report. `cpa auto` already repaired both states, so the only visible difference is the wording of one `cpa doctor` line.
- Unified the Linux linger hint wording shared by `cpa auto` and `cpa doctor`; both commands now print the same remediation line (only their prefixes differ).
- Internal: Windows autostart inspection now reports only registry facts (the Run value and the raw StartupApproved bytes, as UTF-8 base64 JSON). The launcher file is read and compared in Node like the macOS plist and the systemd unit, and all three platforms derive `on`/`off`/`stale`/`disabled` through one shared verdict function, so every detection branch is covered by tests on all platforms.

## [0.3.1] - 2026-08-25

### Changed

- An argument-free `cpa auto` now turns off only a registration that is actually in force: `stale` entries are repaired (launcher rewritten) instead of silently removed, and `disabled` entries are re-enabled as before. `cpa auto off` remains the deterministic cleanup. On Linux, `cpa auto` also prints a note when systemd linger is off, since the user unit starts at login only.
- Panel update checks now resolve the latest release through the same quota-free `github.com` redirect and browser download URL path as CLIProxyAPI binary updates, so `cpa update`, `cpa update --panel`, and `cpa update check` no longer consume GitHub REST API rate limit when the panel is already current.
- The GitHub asset SHA-256 digest is verified only when the REST API fallback supplies one; the default browser-discovery path installs after content sanity checks, with local integrity anchored by the install-time SHA-256 recorded in `install.json`.

### Fixed

- Windows autostart now registers a hidden WScript launcher (`wscript.exe` plus a generated `.vbs` under `%LOCALAPPDATA%\MiniCPA`) instead of launching node.exe directly at logon, so a console window no longer flashes at login. Pre-existing direct-node registrations are detected as `stale` and repaired by an argument-free `cpa auto`; the launcher content (node and CLI paths) is part of `stale` detection, so a moved npm prefix is caught too.
- Derived the macOS launchctl disabled-check pattern from the launch agent label constant, so renaming the label now fails tests instead of silently breaking `disabled` detection.
- Extended `cpa doctor` with read-only autostart diagnostics (registration state plus Linux linger), so broken autostart entries surface without waiting for a reboot.

## [0.3.0] - 2026-08-24

### Added

- Added `cpa auto` to toggle automatic startup for the current user, plus explicit `cpa auto on` / `cpa auto off` modes and effective state reporting through `cpa status`.

### Fixed

- Distinguished stale and OS-disabled registrations from a genuinely absent autostart entry, and made explicit disable remove registrations without relying on inspection.
- Preserved Linux's effective `XDG_DATA_HOME`, rolled back unit files when `systemctl` fails or cannot start, and stopped autostart writes from changing existing standard directory permissions.

## [0.2.1] - 2026-08-24

### Changed

- Eliminated internal dead code, unused helper wrappers (`runCpaTuiProcess`, `normalizeCpaConfig`), and legacy aliases (`buildCpaChildEnv`, `probePidIdentity`) across commands and process lifecycle modules.
- Candidate asset resolution in `cpa update` now fails fast when a fetched release has empty assets instead of attempting a synthetic candidate with no usable download URLs.
- Consolidated test isolation helpers and console capture into a unified `test-env.ts` test fixture.

### Fixed

- Fixed potential environment variable leakage across test suites by restoring process environment variables in a cleanup `finally` block before temporary directory deletion.

### Changed

- **Breaking:** The one managed home is now always `<cpa root>/instance`; the redundant `instances/default` hierarchy and persisted home selection have been removed.
- `cpa init` now creates the configuration and data directories, then installs the latest integrity-checked CLIProxyAPI binary and Web panel. A successful first-time setup no longer needs an immediate `cpa update`.
- `cpa init --force` remains scoped to backing up and replacing `config.yaml`; component reinstallation remains under `cpa update --force`.

### Removed

- Removed automatic discovery and migration of prior instance homes. Version 0.2.0 neither reads nor deletes `instances/default` or the obsolete `config.json` home pointer. Stop a process managed by an older MiniCPA before upgrading.

## [0.1.4] - 2026-08-23

### Added

- Added `cpa web` as the canonical web-panel command while retaining `cpa open` as a hidden compatibility alias.
- Added `-v` alongside `-V` and `--version` for the one-line MiniCPA version.

### Changed

- Running `cpa` without arguments now prints the same grouped help as `cpa --help` and exits successfully.
- Simplified root help by grouping common commands and hiding compatibility/recovery commands and `cpa update --all`.
- A normal `cpa upgrade` now uses a verified `npm update -g @astralyn/minicpa` flow; `--force` retains exact-version reinstallation.
- Standardized CLI output around the names MiniCPA, CLIProxyAPI, Web panel, and Home, with clearer update, rollback, and recovery results.

### Fixed

- `cpa update check` now reports a configured web-panel auto-update opt-out instead of incorrectly claiming the panel is current.
- Panel opt-out output now recommends the narrow `cpa update --panel` override instead of unnecessarily reinstalling both components with `--force`.

## [0.1.3] - 2026-08-22

### Added

- Added `cpa upgrade`, `cpa upgrade check`, and `cpa upgrade --force` for safely updating MiniCPA itself from the official npm registry.
- Added TLS-aware CPA management and readiness URLs, including isolated support for self-signed certificates during local HTTPS probes.
- Added a tokenless npm Trusted Publishing workflow with OIDC provenance and package-install verification.

### Changed

- Clarified that `cpa update` updates only the managed CLIProxyAPI binary and management panel, while `cpa upgrade` updates MiniCPA.
- Restricted automatic MiniCPA upgrades to proven direct npm global installations; npx, linked, local, source, and other package-manager layouts fail closed with a manual recovery command.
- ARM64 CPA updates now try only native `aarch64` and historical `arm64` assets, never AMD64 fallbacks.

### Fixed

- Fixed legacy and tagged macOS process start markers being treated as an identity match when their formats could not be compared safely.
- Fixed npm-global detection falsely rejecting normal macOS `/var` aliases and Windows short-path ancestors as linked installs.
- Fixed `start`, `status`, `open`, and update restart health checks when `tls.enable` is set in `config.yaml`.
