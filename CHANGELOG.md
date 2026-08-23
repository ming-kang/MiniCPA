# Changelog

This file records MiniCPA npm releases beginning with 0.1.3. Earlier repository versions were not published to npm and are not maintained here.

## [Unreleased]

## [0.2.0] - 2026-08-23

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
