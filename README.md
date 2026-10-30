# MiniCPA

MiniCPA provides a cross-platform **`cpa`** command to bootstrap, manage, inspect, and update a local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance.

## Architecture & Principles

MiniCPA is designed as an un-opinionated process supervisor and binary manager around a single local CLIProxyAPI (CPA) instance:

- **Ownership Boundary**: MiniCPA creates a minimal bootstrap `config.yaml` only on first initialization. After that, configuration, provider credentials, routing, and Web panel provisioning belong entirely to CLIProxyAPI. MiniCPA treats configuration as opaque data and never parses, modifies, or synchronizes it.
- **Two-Phase Binary Updates**: Binary downloads, integrity checks, and unpacking occur in an isolated staging workspace without stopping the running service. The lifecycle lock is only acquired during the brief atomic commit phase.
- **Kernel-Level Concurrency**: Concurrency control relies on operating-system-level kernel leases (Named Pipes on Windows, Abstract Unix Sockets on Linux, and Loopback listeners on macOS). Lock files serve solely as diagnostic records and cannot cause deadlock or lock stealing.
- **Process Safety**: Process management tracks both PIDs and platform-specific process start markers to prevent misdirected signals caused by OS PID recycling. Outbound child process environments are automatically stripped of sensitive credentials.

## Installation

Requires **Node.js 24+**.

```bash
npm install -g @astralyn/minicpa
```

Or inspect without a global install:

```bash
npx @astralyn/minicpa --help
```

## Quick Start

```bash
cpa init   # Create the minimal bootstrap config and install the latest CPA binary
cpa start  # Start CLIProxyAPI in the background
cpa web    # Open the management Web panel in your browser
```

The bootstrap configuration listens on `127.0.0.1:8317` with default bootstrap credentials (`sk-cliproxyapi` client key, `CLIPROXYAPI` management password) and enables native file logging. All subsequent configuration is performed directly inside CLIProxyAPI.

## Connection Target

MiniCPA defaults to connecting via `http://127.0.0.1:8317`. If you configure a custom port, reverse proxy, or HTTPS in CLIProxyAPI, specify the target explicitly before any command:

```bash
cpa --api-url https://127.0.0.1:9443 start
cpa --api-url https://127.0.0.1:9443 status
cpa --api-url https://127.0.0.1:9443 web
```

Alternatively, set the `MINICPA_API_URL` environment variable.

## Updates & Upgrades

MiniCPA maintains a strict distinction between the managed daemon and the management CLI:

- **CLIProxyAPI Binary Updates (`cpa update`)**:
  Fetches, verifies, and stages the latest or pinned CLIProxyAPI binary release from upstream GitHub, restarting the service only if replacement succeeds.
  ```bash
  cpa update check
  cpa update
  cpa update --version 8.0.47
  ```

- **MiniCPA CLI Upgrades (`cpa upgrade`)**:
  Checks the npm registry and updates the globally installed `@astralyn/minicpa` npm package in place.
  ```bash
  cpa upgrade check
  cpa upgrade
  ```

## Commands Overview

| Command | Category | Purpose |
|---------|----------|---------|
| `cpa init` | Lifecycle | Generate initial bootstrap config and install CLIProxyAPI |
| `cpa start` | Lifecycle | Start CLIProxyAPI daemon in background and await readiness |
| `cpa stop` | Lifecycle | Gracefully terminate the running CLIProxyAPI daemon |
| `cpa restart` | Lifecycle | Restart the running daemon |
| `cpa auto [on\|off]` | Lifecycle | Toggle or set login autostart (Windows Task/Registry, systemd, launchd) |
| `cpa status` | Lifecycle | Inspect service status, version metadata, and HTTP reachability |
| `cpa web` | Interface | Open the CLIProxyAPI management Web panel in browser |
| `cpa tui` | Interface | Attach to the native CLIProxyAPI terminal UI |
| `cpa logs` | Diagnostics | View native CLIProxyAPI logs (supports `-f`, `-n`, `--err`, `--legacy`) |
| `cpa doctor` | Diagnostics | Non-invasive health and environment diagnostic check |
| `cpa update` | Maintenance | Check or install updates for CLIProxyAPI binary |
| `cpa upgrade` | Maintenance | Check or upgrade the MiniCPA npm package |
| `cpa version` | Information | Display MiniCPA version, CPA version, and instance home |
| `cpa home` | Information | Print the active instance home directory |

## Directory Layout

| Path Target | Windows | macOS | Linux |
|-------------|---------|-------|-------|
| Root (`cpa root`) | `%LOCALAPPDATA%\MiniCPA` | `~/Library/Application Support/MiniCPA` | `$XDG_DATA_HOME/MiniCPA` |
| Instance (`cpa home`) | `<root>\instance` | `<root>/instance` | `<root>/instance` |
| Temp (`cpa temp`) | `<root>\temp` | `<root>/temp` | `<root>/temp` |

Instance data (configuration, authentication credentials, native logs) resides permanently under `<root>/instance`. Uninstalling MiniCPA never removes your instance data or credentials.

For detailed architecture, concurrency, and security models, see [docs/README.md](docs/README.md).

## Development

```bash
git clone https://github.com/ming-kang/MiniCPA.git
cd MiniCPA
npm ci
npm run hooks:install
npm run check
```

- `npm run check`: Run linter, type checks, test suite, and build.
- `npm test`: Run test suite with `node:test`.
- `npm run dev -- <command>`: Execute development entry with `tsx`.

Follow [RELEASING.md](RELEASING.md) for release workflows and see [CHANGELOG.md](CHANGELOG.md) for version history.

## License

[MIT](LICENSE)
