# Changelog

This file records MiniCPA npm releases beginning with 0.1.3. Earlier repository versions were not published to npm and are not maintained here.

## [Unreleased]

### Fixed

- Record the outcome of every CLIProxyAPI start, including `cpa restart` and restarts during `cpa update`, so `cpa status` no longer reports a failed start that a later start already superseded. A `cpa start` that loses the lifecycle lock to another command is no longer recorded as a failed start.
- Make `cpa upgrade` install the exact latest version it just looked up (`npm install -g @astralyn/minicpa@<version>`) instead of `npm update -g`, whose own version resolution could pick a different version and fail the post-upgrade check.

### Changed

- Document that the bootstrap `config.yaml` selects the auto-updating `seakee/CPA-Manager-Plus` Web panel, what that panel is trusted with, and how to change or pin it.
- Run the full Ubuntu, Windows, and macOS CI inside the Publish npm workflow on the commit being published, then wait until npm serves the new version, tag that commit, and create the GitHub Release from its CHANGELOG section. Each job holds only the permissions it needs, and a request for an already published version or existing tag fails before anything runs.
- Add `npm run release:prepare -- x.y.z` to bump `package.json` and `package-lock.json` and date the Unreleased notes in one step.
- Limit the package install smoke test to packaging concerns (contents, shim, `--version`, `--help`); the command surface stays covered by the CLI tests, so CLI changes no longer need a second update there.

## [0.5.0] - 2026-10-30

### Changed

- Make `cpa status` the single overview: status with PID, uptime, and the next step (`cpa init` / `cpa start`), API reachability, Web URL, an explained autostart state, CLIProxyAPI and MiniCPA versions, the instance home, a non-direct download route, and detected problems (missing or backup-only binary, unrecorded version, unreachable HTTP, last failed start). It still exits `0` only when CLIProxyAPI is running and reachable.
- Make bare `cpa auto` show the current state without changing it; only `cpa auto on` / `cpa auto off` change the registration. Stale and OS-disabled registrations are explained with `cpa auto on` as the fix.
- Print `CLIProxyAPI is already running` instead of reporting a fresh start, align all command output to one label column, drop the Home row from action commands, and suggest `taskkill /PID <pid> /T /F` on Windows when a stop fails.
- Group root help into Lifecycle, Interfaces, and Updates with Commander's native help groups, hide the launcher-only `--no-wait`, and restore "Did you mean …?" suggestions for mistyped commands.
- Make `cpa init` print the bootstrap management password and API key once, since CLIProxyAPI hashes the management secret on first start; make `cpa web` note when CLIProxyAPI is not running, still without HTTP probes.
- Streamline codebase comments to retain only non-obvious invariants, OS caveats, and architectural constraints while removing redundant, self-explanatory documentation.
- Refocus `README.md` on high-level system architecture, boundaries, and workflows instead of low-level implementation details.
- Split the former `docs/cpa-reference.md` into focused architectural guides covering dual-lease concurrency (`docs/concurrency.md`), two-phase update pipelines (`docs/update-pipeline.md`), process supervision and autostart (`docs/process-lifecycle.md`), and security isolation boundaries (`docs/security.md`), with `docs/README.md` serving as the unified architecture index.

### Removed

- Remove `cpa doctor`, `cpa version`, `cpa home`, `cpa update check`, and `cpa upgrade check`; `cpa status` now reports their information, and `cpa update` / `cpa upgrade` already say when nothing is newer.
- Remove the hidden `open`, `root`, `temp`, and `clean` commands, the `-V` alias, the legacy `update --all` / `--binary` / `--panel` flags, and `cpa logs --legacy`, together with reading 0.4.3-era `cpa.log` / `cpa.err.log` captures and the old `logs/minicpa.log` event history. Stale staging files are still cleaned before every update.
- Remove the GitHub reachability probe, proxy-environment summary, and recursive directory sizing that only the removed commands used.

### Fixed

- Create `<home>/logs` before every start. CLIProxyAPI writes there only when the directory already exists; fresh 0.4.4+ installs silently logged to `auths/logs` instead, so `cpa logs` found nothing and startup failures such as a port already in use were reported without the reason from `main.log`. Affected instances switch over at the next `cpa restart`; earlier logs stay in `auths/logs`.
- Limit startup failure reports to the `main.log` lines written by that start attempt instead of a fixed tail mixed with earlier runs and request-error logs, and record the headline plus CLIProxyAPI's last log line so `cpa status` shows the actual cause (in local time) instead of a truncated log excerpt.
- Explain an empty `cpa logs` (the log appears once CLIProxyAPI runs with file logging enabled) instead of a generic "no log files" error.

## [0.4.5] - 2026-10-30

### Changed

- Make the kernel lease the sole authority for locking; `<cpa root>/state/cpa.lock` is strictly a diagnostic record (PID, command, timestamp) without PID-reuse arbitration, empty-lock grace periods, retry loops, or lockfile preemption. Stale, empty, corrupt, or live-PID diagnostic files do not block an available lease.
- Retain lifecycle and update split leases and async-scoped reentrancy; do not run different MiniCPA versions concurrently.
- Replace separate 30-second binary unlock rename probes with direct installation renames using Windows retry backoff for transient sharing locks.
- Streamline binary update transactions to a single preparation phase with caller-owned discard cleanup; binary `.bak` rollback and crash recovery remain intact.
- Simplify ordinary MiniCPA state file writes to temporary file plus atomic rename, removing the rename-aside `.replace.bak` protocol.
- Streamline install metadata (`install.json`) to store only `runtimeVersion`; legacy fields are ignored on read and pruned on the next write. Missing metadata is normal on new setups; malformed JSON, non-object metadata, non-string versions and read/write errors fail visibly rather than defaulting to an unknown version.
- Share bounded HTTP text reading for npm metadata and use HTTP status/error codes instead of message matching for asset fallback and network retries. Existing quotas, timeouts and `cpa upgrade` npm update/install commands remain unchanged.
- Make `cpa web` (and its hidden `open` alias) print the panel URL and open the browser immediately, without HTTP probes or waiting for CPA/panel provisioning. Missing browser launchers still produce a non-fatal warning; other launcher errors remain failures.
- Discover release tags without synthesizing all-platform GitHub releases. Resolve only the current target's download candidates and checksum URL when installation is needed, retaining REST fallback, same-architecture ordering and SHA-256 verification.
- Unify graceful/forced process stopping and start-marker comparison without removing fresh ownership checks, PID retention on inconclusive identity, or platform-specific signal behavior.
- Keep one bounded MiniCPA event-log generation through direct rename; a failed rotation preserves both current and previous logs and prevents further appends.
- Enable CPA native file logging in newly created `config.yaml`, with `logs-max-total-size-mb: 32` and `error-logs-max-files: 10`. Existing configurations and logging settings remain untouched on init/update; CPA owns writing and retention.
- Use one npm self-upgrade execution entry point for ordinary updates and exact-version forced installs, retaining installation checks, safe arguments/environment, lock ordering and post-install verification.

### Removed

- Remove destructive binary unlock rename probes and all `.unlock-probe` recovery logic, types, and special cases across doctor, runtime inspection, and TUI launching.
- Remove automatic recovery and doctor handling for legacy `.unlock-probe` and `.replace.bak` residues; document manual review and restoration when canonical files are missing.
- Remove unused bounded configuration-text reading, synchronous temp cleanup, tasklist parsing, multi-generation event-log rotation, and the unused `lastUpdateCheck` field. Drop the Web-only single-URL readiness wrapper and test-loopback exceptions from GitHub asset resolution; offline tests inject discovery/download seams instead.

## [0.4.4] - 2026-10-29

### Changed

- Unify contributor checks under `npm run check`, shared by a lightweight pre-commit hook, CI, and release verification; document test filtering and development commands.
- Make `cpa init` a one-time minimal bootstrap with loopback listening, local authentication and management, and the requested fixed initial keys/panel repository. Preserve all existing configuration, including empty or malformed files; retries never reset user edits. Do not create `.env` or repair permissions on existing CPA files.
- Treat CPA configuration as opaque after bootstrap. Updates never read, synchronize, back up, clean up, or roll it back; all existing configuration snapshots and legacy backups remain untouched. Configuration ownership, validation, defaults and migrations belong to CLIProxyAPI.
- Add an explicit MiniCPA connection target through global `--api-url` or `MINICPA_API_URL`, defaulting to `http://127.0.0.1:8317`, instead of inferring listener/TLS/panel settings from YAML. The native TUI reads its own configuration.
- Separate update preparation and temp cleanup from the lifecycle lock. Download, extract, and copy/fsync before downtime; re-read process state at commit so user start/stop operations during preparation are respected. Binary recovery preserves native configuration changes and still attempts restart when install-metadata repair fails.
- Use CLIProxyAPI's native application/request-error logs and continuous rotation instead of permanent duplicate stdout/stderr captures. Add `cpa logs --legacy`, discover new error filenames while following, and move bounded MiniCPA start events to `state/minicpa.log`. The minimal bootstrap does not enable application file logging; users configure that in CPA.
- Reserve recursive temp statistics for `cpa doctor --deep`, limit its optional GitHub diagnostic to one attempt and three seconds, and keep MiniCPA's own files private without traversing CPA data.
- Bound GitHub metadata to 1 MiB, checksums to 256 KiB, and archive entry/path/decompression work; cancel unused response bodies while retaining existing download integrity checks.

### Removed

- Remove the bundled `config.example.yaml`, YAML parser dependency and configuration-field parsing/normalization, automatic synchronization/history/legacy cleanup, configuration rollback, recursive CPA permission repair, `.env` creation and `cpa init --force`.

### Fixed

- Upgrade `undici` to 7.30.1 to address current network-client security advisories without a major-version change.
- Clean each old download by its own age rather than the shared parent's time, remove temp trees asynchronously without a preliminary size walk, and refuse new update workspaces when prior operation cleanup remains blocked. Reject symlink/junction escapes at temp boundaries and stop event-log appends when rotation fails rather than allowing unlimited growth.

## [0.4.3] - 2026-09-29

### Fixed

- Protect lock recovery with a kernel-owned lease and restrict reentrancy to the owning async operation.
- Restart the previous binary even when rollback metadata cannot be written; prevent stale backups from causing unintended downgrades.
- Preserve existing autostart launchers when registration fails.
- Handle log rotation and access failures without uncaught timer errors, and apply output backpressure.

### Changed

- Redesign `cpa status` as aligned source, MiniCPA/Core version, download route, API, configuration, and runtime fields; redact proxy credentials.
- Stream archive checksums and ZIP extraction, bound subprocess output, and combine Windows process identity queries under one timeout budget.
- Load CLI commands on demand and separate shared contracts from platform and transport implementations.
- Update vulnerable dependencies; keep the ZIP fixture writer in development dependencies only.

## [0.4.2] - 2026-09-03

### Changed

- Switched the default management panel repository to `seakee/CPA-Manager-Plus`.
- Enabled `routing.session-affinity` by default; existing instances receive both operational changes on their next `cpa update`, with the previous config backed up first.

## [0.4.1] - 2026-09-03

### Added

- Added the full Chinese-commented CLIProxyAPI configuration template at `docs/config.example.yaml`; newly initialized instances use it while still generating a private random API key.

### Changed

- `cpa update` now synchronizes an existing `config.yaml` before checking the binary: the template enforces operational settings, machine-local endpoints and credentials retain their values, extra and missing entries are carried forward appropriately, comments and known-key order follow the bundled template, and every changed file is backed up before an atomic replacement.

## [0.4.0] - 2026-09-02

### Changed

- Delegated Web panel provisioning, integrity policy, and periodic updates to CLIProxyAPI itself. `cpa init`, `cpa update`, `cpa update check`, and `cpa version` now track only the managed CLIProxyAPI binary; `cpa web` waits for CLIProxyAPI's first-access panel provisioning.
- Added the upstream `disable-auto-update-panel: false` default to newly generated `config.yaml` files and report CLIProxyAPI's panel ownership in `cpa doctor`.
- Kept `cpa update --all` and `--binary` as hidden binary-update aliases. Legacy `--panel` now exits with migration guidance instead of downloading `management.html`.

### Removed

- Removed MiniCPA's duplicate panel downloader, release check, SHA-256 state, and `install.json` panel version fields. Existing panel contents are preserved, and legacy state fields are pruned on the next binary state write.

## [0.3.3] - 2026-09-01

### Changed

- Read-only runtime reporting (`status`, `version`, `doctor`, and `update check`) now uses the last health-verified install metadata instead of executing the active CLIProxyAPI binary, so it cannot hold a Windows image lock against an in-progress update.
- Binary and Web panel update checks now run concurrently while preserving stable output order, and CLIProxyAPI release asset names are generated from one typed platform/architecture table.
- Pull-request CI now packs and installs the publishable tarball on Linux, macOS, and Windows, with the production dependency audit running once on Linux.

### Fixed

- Preserved the recorded CLIProxyAPI version when an update rolls back to an intact previous binary after a temporary version-probe failure.
- Replaced the lock acquisition attempt count with a deadline that includes the full fresh-empty-lock grace period, allowing abandoned partial lock files to recover automatically.
- Preserved partial log lines and split UTF-8 characters while following stdout and stderr together.

## [0.3.2] - 2026-08-26

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
