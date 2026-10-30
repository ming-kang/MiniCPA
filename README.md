# MiniCPA

MiniCPA provides one cross-platform **`cpa`** command to bootstrap, run, inspect, and update a local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance.

It manages **one instance**. MiniCPA creates a minimal configuration only when `config.yaml` is absent. After that, configuration, provider authentication, and the Web panel belong to CLIProxyAPI. MiniCPA never parses, synchronizes, replaces, backs up, or cleans up existing configuration.

## Install

Requires **Node.js 24+**.

```bash
npm install -g @astralyn/minicpa
```

Or inspect the CLI without a global installation:

```bash
npx @astralyn/minicpa --help
```

Running `cpa`, `cpa -h`, or `cpa --help` prints the same help. `cpa -v`, `cpa -V`, and `cpa --version` print the MiniCPA version.

## Quick start

```bash
cpa init   # create the minimal config once and install the latest CPA binary
cpa start  # start CPA; it provisions and updates its own Web panel
cpa web    # open the Web panel and complete setup in CPA
```

The one-time bootstrap binds CPA to `127.0.0.1:8317`, uses `auths` beside the binary, and enables the `seakee/CPA-Manager-Plus` panel with automatic updates. The initial client key is **`sk-cliproxyapi`** and the management password is **`CLIPROXYAPI`**. These are public bootstrap credentials: replace them in CPA during initial setup, especially before exposing the service beyond your machine.

The bootstrap contains local listener, authentication, management, and native file-log settings. Native logging starts enabled with `logs-max-total-size-mb: 32` and `error-logs-max-files: 10`; CPA owns log writing and retention. There is no bundled `config.example.yaml`, generated random key, or `.env` creation. Routing, TLS, provider settings, and all later changes (including logging) are configured in CPA itself. See the [official CPA manual](https://help.router-for.me/cn/).

A repeated `cpa init` leaves an existing configuration untouched, even if it is empty or malformed. Binary download failures leave the initial configuration in place, so installation can be retried without resetting subsequent user edits. A configuration write/flush failure aborts initialization and leaves the created path for inspection; review a potentially incomplete file before retrying. **`cpa init --force` has been removed**; use `cpa update --force` only to reinstall the binary.

MiniCPA uses the one directory printed by `cpa home`: `<cpa root>/instance`. `--home` and `CPA_HOME` are intentionally unsupported. It does not repair permissions or traverse existing CPA configuration, `.env`, credentials, static assets, logs, or configuration backups. MiniCPA's own directories and newly written state files remain private (`0700`/`0600` on POSIX). State writes use temporary files and atomic rename without a `.replace.bak` protocol; review and restore any legacy `.replace.bak` or `.unlock-probe` residue manually if a canonical file is missing.

## Connection target, without configuration parsing

MiniCPA's readiness probes and Web launcher default to **`http://127.0.0.1:8317`**, matching the bootstrap. It does not infer the current listener, port, TLS settings, panel switches, or credentials from YAML.

If you change CPA's listener or enable HTTPS, explicitly tell MiniCPA which API base URL to use. The global option goes **before the command**:

```bash
cpa --api-url https://127.0.0.1:9443 start
cpa --api-url https://127.0.0.1:9443 status
cpa --api-url https://127.0.0.1:9443 web
cpa --api-url https://127.0.0.1:9443 update
```

Alternatively, set **`MINICPA_API_URL`** in the invoking environment. The command-line option takes precedence. This changes only MiniCPA's connection target; it never writes or configures CPA's listener. Use an HTTP(S) base URL without embedded credentials, query, or fragment. Reverse-proxy path prefixes and IPv6 URLs are supported.

`cpa web` prints the panel URL and immediately opens it in your browser. It does not probe CPA, require a local installation, or wait for panel provisioning; CPA owns the panel and the browser shows access errors. If no browser launcher is available, the URL remains usable and a warning is printed.

`cpa tui` delegates to the official CPA terminal UI with the instance's config path; CPA itself reads its configuration and handles the terminal UI's connection and authentication.

## Update CLIProxyAPI or MiniCPA

The two update commands have separate targets:

- **`cpa update`** prepares and replaces the managed CLIProxyAPI binary only.
- **`cpa upgrade`** upgrades the globally installed MiniCPA npm package.

### CLIProxyAPI binary updates

```bash
cpa update check
cpa update
cpa update --version 8.0.47
cpa update --force
```

Downloads, integrity checks, extraction, and target-volume copy/fsync finish in a single preparation phase before a running CPA process is stopped. Commit takes the lifecycle lease, re-reads the current binary/process state, and restarts only when a currently running instance's binary is replaced. A user start or stop during preparation is respected. An already-current binary is skipped unless a reinstall or explicit version is requested.

**Updates never read or rewrite configuration, validate its syntax, create configuration snapshots, or delete old configuration backups.** Existing fixed-slot, timestamped, manual, and atomic-recovery config files are left untouched. This applies to ordinary updates, pinned versions, forced reinstalls, already-current checks, and failures. Remove old configuration backups manually only if desired; they may contain credentials.

Binary rollback uses only the backup created by that update (`.bak`). A stale backup cannot replace an untouched active binary. Binary installation replaces the file directly using Windows retry backoff for transient locks instead of separate unlock probes. If install metadata cannot be repaired during recovery, MiniCPA still attempts to restart the previous binary and reports the metadata error. Configuration changes or migrations made by CPA itself are **not rolled back** by MiniCPA.

Archives are verified against upstream `checksums.txt`; `--insecure` skips that verification and is unsafe. No new integrity or hash scheme is introduced. `cpa update check` exits 1 when an update is available or the check fails.

The kernel lease is the sole authority for synchronization; `<cpa root>/state/cpa.lock` is a diagnostic record storing PID, command, and timestamp only. Stale, empty, corrupt, or live-PID diagnostic files do not block an available lease. Preparation and cleanup use a separate lease at `<cpa root>/state/update/cpa.lock`, so downloads and cleanup do not block start/stop. Async-scoped reentrancy remains. The installing phase of `cpa upgrade` takes both leases to protect active package modules. Do not run different MiniCPA versions concurrently.

### MiniCPA upgrades

For a writable, direct npm-global installation:

```bash
cpa upgrade check
cpa upgrade
```

After comparing npm `latest` with the current version, MiniCPA verifies the active installation and runs the safe equivalent of:

```bash
npm update -g @astralyn/minicpa
```

The npm process uses the detected global prefix, official registry, fixed argument boundaries, disabled install scripts, and a credential-safe environment. MiniCPA verifies the installed manifest afterwards. A locally newer version is never downgraded. `cpa upgrade --force` reinstalls the exact npm `latest` version only when a reinstall is needed.

Automatic upgrade refuses npx caches, `npm link`, source checkouts, project dependencies, pnpm/yarn/bun layouts, ambiguous prefixes, and read-only installations. Follow the reported reason and use the package manager that owns the installation; for a direct npm installation:

```bash
npm install -g @astralyn/minicpa@latest
```

Upgrading MiniCPA does not stop, restart, or modify the managed CPA process or configuration.

## Commands

| Command | Purpose |
|---------|---------|
| `cpa init` | Create the minimal configuration once and install the latest CPA binary |
| `cpa start` | Start CPA in the background and wait for the explicit/default API target |
| `cpa stop` | Stop the managed CPA process |
| `cpa restart` | Restart the managed process |
| `cpa auto [on\|off]` | Toggle or explicitly set login autostart |
| `cpa status` | Show runtime/autostart state, versions, paths, connection target and HTTP reachability |
| `cpa web` | Print the panel URL and open it directly in your browser |
| `cpa tui` | Launch the official CPA terminal UI; CPA must already be running |
| `cpa logs` | Read native logs; supports `-n`, `--err`, `--legacy`, and `-f` |
| `cpa update` / `cpa update check` | Update or inspect the CPA binary only |
| `cpa upgrade` / `cpa upgrade check` | Upgrade or inspect the MiniCPA npm package |
| `cpa doctor` | Diagnose installation, process, autostart, network and staging issues without parsing CPA configuration |
| `cpa version` | Show MiniCPA/CPA versions and instance home |
| `cpa home` | Print the managed instance directory |

`cpa open` is a hidden compatibility alias for `cpa web`. `clean`, `root`, and `temp` remain callable but are omitted from root help. The legacy `update --all` and `--binary` flags remain binary-update aliases; `--panel` prints migration guidance because CPA owns its panel downloads and updates.

`cpa auto` changes only future login startup; it does not install, start, or stop CPA immediately. Enabling requires a stable direct npm-global installation. Windows registers a hidden WScript launcher; Linux uses a systemd user unit recording the effective `XDG_DATA_HOME`; macOS uses a LaunchAgent. On headless Linux, also enable user linger if startup without login is required. `cpa auto off` performs deterministic cleanup even when inspection is unavailable.

Autostart state is `on`, `off`, `stale`, `disabled`, or `unknown`. An argument-free `cpa auto` repairs stale or OS-disabled registrations. Registering before the binary or config exists prints a note. Autostart runs `cpa start --no-wait` and does not require an HTTP target to start the process.

Each `cpa start` records its outcome in `<home>/state/minicpa.log` (1 MiB threshold, one rotated generation). It is outside CPA's log-cleaning directory. Doctor can report the last failure and falls back to old `logs/minicpa.log` history until a new event exists.

## Native logs and diagnostics

`cpa logs` reads native `logs/main.log`; `--err` selects the ten newest `error-*.log` request-error files. `-f` follows replacement and discovers new error filenames with UTF-8/partial-line handling and backpressure. Shell `WRITABLE_PATH` / `writable_path` overrides are honored; MiniCPA does not load CPA's `.env`.

**New bootstraps enable native application file logging**, with a 32 MB total-size setting and ten request-error log files. Existing configurations are never migrated; enable native logging in CPA yourself if an older config has it disabled. New detached starts discard stdout/stderr rather than create permanent duplicate captures. Raw stderr/panic output outside native logging is not permanently captured. Old running processes keep their capture descriptors until restarted; `cpa logs --legacy` reads those old files, with a warned fallback when native files are absent.

Status, version, doctor, and binary checks use the recorded `runtimeVersion` instead of executing the active binary. Install metadata contains only this field; legacy fields are ignored on read and dropped on the next state write. Missing metadata is normal before the first install; malformed JSON, invalid metadata shapes/versions, or I/O errors fail visibly rather than silently defaulting to an unknown version. Doctor checks configuration presence, not its syntax or secrets. CPA reports configuration errors; MiniCPA does not try to repair them. Windows doctor uses a transient write probe to check directory access.

`cpa clean` asynchronously removes private staging older than one hour, judging each legacy download by its own age. Updates clear orphaned operation directories before preparing another; blocked removal prevents further workspace growth. Neither path touches instance configuration or backups. Doctor skips recursive size statistics unless `--deep` is requested; its optional GitHub probe has one attempt and a three-second total budget.

## Network and security

GitHub/npm requests honor `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` in either case. `ALL_PROXY` is an HTTP/HTTPS fallback only; SOCKS values are reported but not applied. CPA inherits the configured proxy environment for its own network operations.

CPA readiness probes bypass environment proxies and accept self-signed certificates through an isolated dispatcher. GitHub and npm retain normal certificate verification. GitHub/npm credential environment variables are stripped from CPA children, version probes, and npm upgrades.

Existing archive SHA-256 verification and process-identity protection are retained. Inputs are bounded to 1 MiB for GitHub metadata, 256 KiB for checksums, 64 KiB for npm metadata, and 512 MiB for archives/executable data; npm metadata uses a shared bounded HTTP text reader and typed HTTP status decisions. Extraction limits archive entry count, path depth, and actual TAR decompression. MiniCPA never loads configuration text, so it has no configuration-text size limit or YAML dependency.

## Paths and uninstall

| Command | Windows | macOS | Linux |
|---------|---------|-------|-------|
| `cpa root` | `%LOCALAPPDATA%\MiniCPA` | `~/Library/Application Support/MiniCPA` | `$XDG_DATA_HOME/MiniCPA` or `~/.local/share/MiniCPA` |
| `cpa home` | `<root>\instance` | `<root>/instance` | `<root>/instance` |
| `cpa temp` | `<root>\temp` | `<root>/temp` | `<root>/temp` |

CPA remains running if MiniCPA is uninstalled. Stop it and remove autostart first:

```bash
cpa auto off
cpa stop
cpa home
cpa root
npm uninstall -g @astralyn/minicpa
```

Uninstalling never deletes configuration, credentials, logs, backups, or instance data. If MiniCPA was already removed, stop the PID recorded in `<home>/state/cpa.pid` manually and remove its user autostart registration. Remove `cpa root` only after CPA has stopped and you have reviewed the data you want to preserve.

See [docs/cpa-reference.md](docs/cpa-reference.md) for lifecycle, locking, recovery, and troubleshooting details. Release notes are in [CHANGELOG.md](CHANGELOG.md).

## Develop

```bash
git clone https://github.com/ming-kang/MiniCPA.git
cd MiniCPA
npm ci
npm run hooks:install
npm run dev -- --help
```

| Command | Purpose |
|---------|---------|
| `npm run check` | Lint, type-check, test, and build; shared by pre-commit and CI |
| `npm test` | Type-check and run tests |
| `npm test -- lifecycle` | Filter test files by path; multiple filters match any |
| `npm run typecheck` | Check TypeScript without emitting files |
| `npm run lint` / `npm run lint:fix` | Check or fix source formatting |
| `npm run build` | Clean and rebuild `dist/` |
| `npm run verify:package` | Pack and verify installation in a temporary project; requires network |
| `npm run audit:prod` | Audit production dependencies; requires network |

The CLI entry is `src/cli.ts`; commands, process management and updates live under `src/commands/`, `src/process/` and `src/update/`. Tests use `node:test` through `tsx`, isolated temporary directories and local HTTP fixtures. `docs/` contains references, not a CPA configuration template; `dist/` is generated. Follow [RELEASING.md](RELEASING.md) for publication.

## License

[MIT](LICENSE)
