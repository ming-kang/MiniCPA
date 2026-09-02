# MiniCPA

MiniCPA provides one cross-platform **`cpa`** command to set up, run, inspect, and update a local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance.

It manages **one instance**. Configuration, provider authentication, and the Web panel asset remain in CLIProxyAPI; MiniCPA handles the instance files, background process, interface launchers, binary updates, and diagnostics.

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
cpa init   # create config.yaml and install the latest CLIProxyAPI binary
cpa start  # start CLIProxyAPI; it provisions and updates its own Web panel
cpa web    # open the web management panel
```

`cpa init` generates a random `api-keys` entry in `config.yaml` without printing it, then downloads and integrity-checks the latest CLIProxyAPI binary. Rotate the key before exposing the API publicly. If the binary download fails, the initialized configuration remains in place and `cpa init` can be retried. `cpa init --force` backs up and replaces only `config.yaml`; use `cpa update --force` to reinstall the binary.

MiniCPA always uses the one directory printed by `cpa home`: `<cpa root>/instance`. `--home` and `CPA_HOME` are intentionally unsupported.

## Update CLIProxyAPI or MiniCPA

The two update commands have separate targets:

- **`cpa update`** synchronizes `config.yaml` with MiniCPA's bundled template, then updates the managed CLIProxyAPI binary.
- **`cpa upgrade`** upgrades the globally installed MiniCPA npm package.

CLIProxyAPI itself owns `management.html`: it checks the configured panel repository when the service starts and periodically while running, and it provisions a missing panel on first access. `disable-auto-update-panel: true` stops startup/periodic replacement but still permits that first missing-file download; `disable-control-panel: true` disables both the asset and route. MiniCPA opens the panel but never downloads, versions, or replaces it. See the upstream [Web UI documentation](https://github.com/router-for-me/CLIProxyAPIDocs/blob/main/docs/en/management/webui.md).

### CLIProxyAPI binary updates

Before checking the binary, `cpa update` rebuilds an existing `config.yaml` from the bundled [`docs/config.example.yaml`](docs/config.example.yaml). The template is authoritative for operational settings, including logging limits, retries, routing, and feature switches. Machine-local endpoint settings (`host`, `port`, `tls`, `proxy-url`), credentials/secrets, `auth-dir`, and `plugins.configs` keep their existing values; extra keys are retained; missing keys are added; comments/order follow the current template. A changed file is backed up as `config.yaml.bak.<timestamp>` and written atomically. A missing config is left for `cpa init`; invalid YAML aborts before the binary update. Synchronization still runs when the binary is already current.

Downloads and integrity checks finish before a running CLIProxyAPI process is stopped; it is restarted only when its binary is replaced. An already-current binary is skipped unless `--force` is used. If only the config changed, MiniCPA prints that it will take effect on the next `cpa start` or `cpa restart`.

```bash
cpa update check       # check the binary without installing
cpa update             # update the binary
cpa update --version 7.2.66
```

Binary archives are verified against upstream `checksums.txt`. `--insecure` skips that verification and is unsafe. `cpa update check` exits 1 when a binary update is available or the check fails.

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
| `cpa init` | Set up `config.yaml` and install the latest CLIProxyAPI binary |
| `cpa start` | Start CLIProxyAPI in the background; waits until HTTP/HTTPS is ready |
| `cpa stop` | Stop CLIProxyAPI |
| `cpa restart` | Restart CLIProxyAPI |
| `cpa auto [on\|off]` | Toggle or explicitly set automatic startup for the current user |
| `cpa status` | Show runtime and autostart status, versions, and API/web endpoints; exits 1 when stopped or unreachable |
| `cpa web` | Open the web management panel; prints the URL when no browser launcher is available |
| `cpa tui` | Open the CLIProxyAPI terminal UI; CLIProxyAPI must already be running |
| `cpa logs` | Show logs; supports `-n`, `--err`, and `-f` |
| `cpa update` / `cpa update check` | Synchronize config and update the binary, or inspect the binary only |
| `cpa upgrade` / `cpa upgrade check` | Upgrade or inspect the MiniCPA npm package |
| `cpa doctor` | Run installation, autostart, runtime, network, and integrity diagnostics |
| `cpa version` | Show MiniCPA, CLIProxyAPI, and home information |
| `cpa home` | Print the managed instance directory |

`cpa open` remains a compatibility alias for `cpa web`. Advanced recovery/path commands (`clean`, `root`, and `temp`) remain callable but are intentionally omitted from root help.

`cpa auto` toggles login autostart; `cpa auto on` and `cpa auto off` set it explicitly. Use the explicit `off` form for deterministic cleanup even when inspection is unavailable. Enabling requires a stable, direct npm-global MiniCPA installation; npx caches, local/source installs, and links are rejected. It changes only future automatic startup and does not start or stop the current CLIProxyAPI process. On Windows it registers a hidden WScript launcher (`wscript.exe` plus a generated `.vbs` under `%LOCALAPPDATA%\MiniCPA`), so `cpa start --no-wait` no longer flashes a console window at logon. Linux uses a systemd user unit and records the effective `XDG_DATA_HOME` so the login service selects the same MiniCPA instance; that unit starts at login, so a headless machine also needs `loginctl enable-linger` (an argument-free `cpa auto` prints this hint when linger is off).

`cpa status` reports `Autostart  on`, `off`, `stale`, or `disabled`. `stale` means an OS registration exists but targets a different launcher; an argument-free `cpa auto` repairs it. `disabled` means the registration is present but disabled by the OS; an argument-free `cpa auto` re-enables it. Inspection failures are reported as `unknown` without hiding runtime status. Read-only commands report the CLIProxyAPI version last recorded after a healthy install/restart and never execute the active binary, so they cannot hold a Windows image lock against `cpa update`.

`cpa auto on` only schedules `cpa start --no-wait`; it installs nothing. Enabling it before `cpa init` or `cpa update` still succeeds, but prints a `Note:` naming the missing config or binary — otherwise that start would fail at every login without anyone seeing it. Every `cpa start` records its outcome in `<cpa home>/logs/minicpa.log`, since a login launch discards its own output and pre-spawn failures never reach CLIProxyAPI's logs; `cpa doctor` replays the last record when it was a failure.

`cpa logs` prints the last `-n, --lines <n>` lines from stdout and stderr logs (default `80`; positive whole numbers only). `--err` selects the error log, while `-f`/`--follow` streams new output and ignores `--lines`.

Errors print a short message. Set `DEBUG=1` to include stack traces.

## Network and security

MiniCPA honors `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (upper or lower case) for GitHub and npm requests. `ALL_PROXY` is an HTTP/HTTPS fallback only when its URL uses `http://` or `https://`; a `socks5://` value is reported but not applied. `cpa doctor` shows the detected proxy environment.

Local readiness probes bypass proxy variables. With `tls.enable: true`, those isolated probes use HTTPS and accept a self-signed local certificate; GitHub and npm retain normal certificate validation.

`GITHUB_TOKEN` or `GH_TOKEN` can increase GitHub API quota for MiniCPA's binary-release fallback and doctor probe. GitHub/npm credential environment variables are removed from CLIProxyAPI child processes, version probes, and npm upgrade processes; CLIProxyAPI's panel updater still inherits the configured HTTP proxy settings.

Mutating lifecycle commands, `cpa auto`, `cpa update`, `cpa clean`, and the installing phase of `cpa upgrade` share one exclusive MiniCPA lock. A blocked command reports the in-flight command and PID.

## Paths and uninstall

| Command | Windows | macOS | Linux |
|---------|---------|-------|-------|
| `cpa root` | `%LOCALAPPDATA%\MiniCPA` | `~/Library/Application Support/MiniCPA` | `$XDG_DATA_HOME/MiniCPA` or `~/.local/share/MiniCPA` |
| `cpa home` | `…\MiniCPA\instance` | same under root | same under root |
| `cpa temp` | `<cpa root>\temp` | `<cpa root>/temp` | `<cpa root>/temp` |

CLIProxyAPI runs detached and remains running if MiniCPA is uninstalled. Stop it first and record the data paths:

```bash
cpa auto off  # remove active, stale, or OS-disabled autostart registrations
cpa stop
cpa home
cpa root
npm uninstall -g @astralyn/minicpa
```

If MiniCPA was removed first, use the PID in `<cpa home>/state/cpa.pid` with `taskkill /PID <pid> /F` on Windows or `kill <pid>` elsewhere. Uninstalling MiniCPA never deletes `config.yaml`, API keys, provider OAuth tokens under `auths/`, logs, or other instance data. Remove `cpa root` manually only after CLIProxyAPI has stopped.

Uninstalling also leaves any autostart registration in place, and it keeps firing at every login against a CLI that no longer exists — silently on Windows. If you skipped `cpa auto off` above, remove it by hand: the `MiniCPA` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` plus `%LOCALAPPDATA%\MiniCPA\minicpa-autostart.vbs` on Windows, `~/Library/LaunchAgents/com.astralyn.minicpa.plist` on macOS, or `systemctl --user disable minicpa.service` and `~/.config/systemd/user/minicpa.service` on Linux.

See [docs/cpa-reference.md](docs/cpa-reference.md) for detailed lifecycle, locking, update, and troubleshooting behavior. Release notes are in [CHANGELOG.md](CHANGELOG.md).

## Develop

```bash
git clone https://github.com/ming-kang/MiniCPA.git
cd MiniCPA
npm install
npm run lint
npm test
npm run build
npm run verify:package
npm link   # optional: expose the local build as cpa
```

## License

[MIT](LICENSE)
