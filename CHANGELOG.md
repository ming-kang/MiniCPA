# Changelog

This file records MiniCPA npm releases beginning with 0.1.3. Earlier repository versions were not published to npm and are not maintained here.

## [Unreleased]

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
- Fixed `start`, `status`, `open`, and update restart health checks when `tls.enable` is set in `config.yaml`.
