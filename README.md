# MiniCPA

MiniCPA provides one cross-platform **`cpa`** command to set up, run, inspect, and update a local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance.

It manages **one instance**. Configuration and provider authentication remain in CLIProxyAPI; MiniCPA handles its files, background process, web and terminal interfaces, updates, and diagnostics.

## Install

Requires **Node.js 24+**.

```bash
npm install -g @astralyn/minicpa
```

Or run it without a global installation:

```bash
npx @astralyn/minicpa --help
```

Running `cpa`, `cpa -h`, or `cpa --help` prints the same help. `cpa -v`, `cpa -V`, and `cpa --version` all print the MiniCPA version.

## Quick start

```bash
cpa init   # create config.yaml and install the latest CLIProxyAPI + Web panel
cpa start  # start CLIProxyAPI in the background
cpa web    # open the web management panel
```

`cpa init` generates a random `api-keys` entry in `config.yaml` without printing it, then downloads and integrity-checks the latest CLIProxyAPI binary and Web panel. Rotate the key before exposing the API publicly. If a component download fails, the initialized configuration remains in place and `cpa init` can be retried. `cpa init --force` backs up and replaces only `config.yaml`; use `cpa update --force` to reinstall components.

MiniCPA always uses the one directory printed by `cpa home`: `<cpa root>/instance`. `--home` and `CPA_HOME` are intentionally unsupported.

## Update CLIProxyAPI or MiniCPA

The two update commands have separate targets:

- **`cpa update`** updates the managed CLIProxyAPI binary and web panel.
- **`cpa upgrade`** upgrades the globally installed MiniCPA npm package.

### CLIProxyAPI updates

A plain `cpa update` updates both components. Downloads and integrity checks finish before a running CLIProxyAPI process is stopped; it is restarted only when its binary is replaced. Already-current components are skipped unless `--force` is used.

```bash
cpa update check       # check both components without installing
cpa update             # update both components
cpa update --binary    # binary only
cpa update --panel     # web panel only
cpa update --version 7.2.66
```

Binary archives are verified against upstream `checksums.txt`; the web panel requires its published GitHub SHA-256 asset digest. `--insecure` skips only binary checksum verification and is unsafe.

If `remote-management.disable-auto-update-panel: true` is set in `config.yaml`, a plain update leaves the panel alone and `update check` reports it as ignored. Explicit installation through `cpa init` or `cpa update --panel` still installs it.

`cpa update check` exits 1 when an update is available or either component check fails. If the binary succeeds but the panel fails, the command preserves and reports the binary result, exits 1, and recommends retrying only `cpa update --panel`.

### MiniCPA upgrades

For a writable, direct npm-global installation:

```bash
cpa upgrade check
cpa upgrade
```

After comparing the current version with npm `latest`, `cpa upgrade` verifies the active installation and runs the safe equivalent of:

```bash
npm update -g @astralyn/minicpa
```

The npm process uses the detected global prefix, the official registry, fixed argument boundaries, disabled install scripts, and a credential-safe environment. MiniCPA verifies the installed package manifest afterwards. A locally newer MiniCPA version is never downgraded. `cpa upgrade --force` is the explicit exception that reinstalls the exact npm `latest` version when a reinstall is needed.

Automatic upgrade refuses npx caches, `npm link`, source checkouts, project dependencies, pnpm/yarn/bun layouts, ambiguous prefixes, and read-only installations. Follow the reported reason and update with the package manager that owns the installation; for a direct npm installation the recovery command is:

```bash
npm install -g @astralyn/minicpa@latest
```

Upgrading MiniCPA does not stop, restart, or modify the managed CLIProxyAPI process.

## Commands

| Command | Purpose |
|---------|---------|
| `cpa init` | Set up `config.yaml` and install the latest CLIProxyAPI and Web panel |
| `cpa start` | Start CLIProxyAPI in the background; waits until HTTP/HTTPS is ready |
| `cpa stop` | Stop CLIProxyAPI |
| `cpa restart` | Restart CLIProxyAPI |
| `cpa auto` | Toggle automatic startup for the current user |
| `cpa status` | Show runtime and autostart status, versions, and API/web endpoints; exits 1 when stopped or unreachable |
| `cpa web` | Open the web management panel; prints the URL when no browser launcher is available |
| `cpa tui` | Open the CLIProxyAPI terminal UI; CLIProxyAPI must already be running |
| `cpa logs` | Show logs; supports `-n`, `--err`, and `-f` |
| `cpa update` / `update check` | Update or inspect CLIProxyAPI and the web panel |
| `cpa upgrade` / `upgrade check` | Upgrade or inspect the MiniCPA npm package |
| `cpa doctor` | Run installation, runtime, network, and integrity diagnostics |
| `cpa version` | Show MiniCPA, CLIProxyAPI, web panel, and home information |
| `cpa home` | Print the managed instance directory |

`cpa open` remains a compatibility alias for `cpa web`. Advanced recovery/path commands (`clean`, `root`, and `temp`) remain callable but are intentionally omitted from root help.

`cpa auto` toggles login autostart on or off. It changes only future automatic startup and does not start or stop the current CLIProxyAPI process.

`cpa logs` prints the last `-n, --lines <n>` lines from stdout and stderr logs (default `80`; positive whole numbers only). `--err` selects the error log, while `-f`/`--follow` streams new output and ignores `--lines`.

Errors print a short message. Set `DEBUG=1` to include stack traces.

## Network and security

MiniCPA honors `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (upper or lower case) for GitHub and npm requests. `ALL_PROXY` is an HTTP/HTTPS fallback only when its URL uses `http://` or `https://`; a `socks5://` value is reported but not applied. `cpa doctor` shows the detected proxy environment.

Local readiness probes bypass proxy variables. With `tls.enable: true`, those isolated probes use HTTPS and accept a self-signed local certificate; GitHub and npm retain normal certificate validation.

`GITHUB_TOKEN` or `GH_TOKEN` can increase GitHub API quota for panel metadata. GitHub/npm credential environment variables are removed from CLIProxyAPI child processes, version probes, and npm upgrade processes.

Mutating lifecycle commands, `cpa auto`, `cpa update`, `cpa clean`, and the installing phase of `cpa upgrade` share one exclusive MiniCPA lock. A blocked command reports the in-flight command and PID.

## Paths and uninstall

| Command | Windows | macOS | Linux |
|---------|---------|-------|-------|
| `cpa root` | `%LOCALAPPDATA%\MiniCPA` | `~/Library/Application Support/MiniCPA` | `$XDG_DATA_HOME/MiniCPA` or `~/.local/share/MiniCPA` |
| `cpa home` | `…\MiniCPA\instance` | same under root | same under root |
| `cpa temp` | `<cpa root>\temp` | `<cpa root>/temp` | `<cpa root>/temp` |

CLIProxyAPI runs detached and remains running if MiniCPA is uninstalled. Stop it first and record the data paths:

```bash
cpa auto  # turn autostart off if status currently shows it on
cpa stop
cpa home
cpa root
npm uninstall -g @astralyn/minicpa
```

If MiniCPA was removed first, use the PID in `<cpa home>/state/cpa.pid` with `taskkill /PID <pid> /F` on Windows or `kill <pid>` elsewhere. Uninstalling MiniCPA never deletes `config.yaml`, API keys, provider OAuth tokens under `auths/`, logs, or other instance data. Remove `cpa root` manually only after CLIProxyAPI has stopped.

See [docs/cpa-reference.md](docs/cpa-reference.md) for detailed lifecycle, locking, update, and troubleshooting behavior. Release notes are in [CHANGELOG.md](CHANGELOG.md).

## Develop

```bash
git clone https://github.com/ming-kang/MiniCPA.git
cd MiniCPA
npm install
npm run lint
npm test
npm run build
npm link   # optional: expose the local build as cpa
```

## License

[MIT](LICENSE)
