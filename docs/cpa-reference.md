# MiniCPA CLI reference

MiniCPA manages one local CLIProxyAPI process and its updates. Configuration and provider authentication remain in CLIProxyAPI itself through the web panel, terminal UI, or `cli-proxy-api -config ...` flags.

Running `cpa` without arguments is equivalent to `cpa --help`. The `-v`, `-V`, and `--version` flags print only the MiniCPA version; `cpa version` reports all installed components and the instance home.

When MiniCPA starts CLIProxyAPI:

- **Working directory** = the one managed instance directory (`cpa home`)
- **Args** = `-config <home>/config.yaml`
- **Binary** = `<home>/cli-proxy-api` (or `.exe` on Windows) — replaced in place by `cpa update`
- **Logs** = `<home>/logs/cpa.log` and `<home>/logs/cpa.err.log`
- **Child env** = parent env minus MiniCPA secrets (`GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_PAT`, `NPM_TOKEN`, `NPM_AUTH_TOKEN`, `NODE_AUTH_TOKEN`, …) in any environment-variable casing — including the locked update path's version probe via `cli-proxy-api --help`
- **Outbound HTTP (CLIProxyAPI update / MiniCPA upgrade / doctor GitHub probe)** honors shell proxy env: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (case-insensitive). `ALL_PROXY` is a fallback for both schemes **only** when it is an `http://` or `https://` URL; any other scheme (`socks5://`, …) is not applied and `cpa doctor` labels it `(scheme not applied)` — set `HTTP_PROXY`/`HTTPS_PROXY` instead. Local `cpa start` / `cpa status` readiness probes use a dedicated direct dispatcher, so they are unaffected by proxy env vars, including under `NODE_USE_ENV_PROXY` / `--use-env-proxy`. With `tls.enable: true`, those probes use HTTPS and accept a self-signed certificate only through that isolated local dispatcher; GitHub/npm requests retain normal certificate validation.
- **Upgrade npm env** also removes the credential keys above while preserving PATH and proxy settings. Install scripts are disabled. A normal `cpa upgrade` runs npm's named global update and verifies it reached the exact version returned by the registry; `--force` reinstalls that exact version.

Default `config.yaml` from `cpa init` uses `auth-dir: auths` (relative to home). Optional `.env` in the same directory is loaded by CLIProxyAPI at startup. After writing these files, `cpa init` installs the latest integrity-checked CLIProxyAPI binary and Web panel; it does not start the process.

OAuth, routing, API keys, and management secrets: edit `config.yaml` / `.env` or use the web management panel after `cpa web`.

## Default config notes

`cpa init` writes a starter `config.yaml` that includes:

- a **random** `api-keys` entry stored only in `config.yaml` — rotate it before public exposure (`cpa doctor` also warns if the legacy `sk-cliproxyapi` remains)
- `host: 127.0.0.1` / `port: 8317` — local-only by default
- `commercial-mode: true` — CLIProxyAPI product flag; adjust if your deployment expects otherwise
- `tls.enable: false` — when enabled with the corresponding CLIProxyAPI certificate/key settings, MiniCPA uses `https://` for readiness, status, and management URLs

`cpa init --force` overwrites `config.yaml` after copying it to `config.yaml.bak.<timestamp>` (previous backups are kept). The flag does not force component reinstallation; use `cpa update --force` for that. Initialization is retryable: a binary failure skips the panel and leaves the generated configuration in place, while a panel failure keeps the successfully installed binary and recommends `cpa update --panel`.

MiniCPA manages one instance at `<cpa root>/instance`. `cpa home` prints its location. `--home` and `CPA_HOME` are unsupported.

## Lifecycle and locking

- `cpa start`, `stop`, `restart`, `auto`, `init`, `update`, `clean`, and the installing phase of `upgrade` take one exclusive lock at `<cpa root>/state/cpa.lock` (atomic create via `O_EXCL` / `wx`). `cpa upgrade check` and an already-current upgrade do not take the lock.
- If another MiniCPA command holds the lock, you get an error naming its PID — wait and retry.
- Stale locks (dead PID, or PID reuse detected via a process start marker) are preempted safely: the lock is renamed aside, its content re-verified against the stale decision, and only then removed. A freshly created but not-yet-written lock is waited out, never deleted.
- PID ownership requires an exact executable-path match **or** a matching spawn-time start marker (boot id + process start time, immune to PID reuse). If neither can be verified, MiniCPA preserves the PID record to avoid a duplicate start and **refuses to terminate the process**.
- Stop waits for process death after force-kill before clearing the PID file. `cpa stop` no longer waits for the binary **file** to become unlocked — that wait belongs to `cpa update`, which performs it before replacing the binary.
- Windows stop: soft `taskkill /T`; when the graceful signal cannot be delivered (typical for the windowless background process), MiniCPA force-kills immediately instead of waiting out the grace period, so stop completes in about a second. Unlock probes recover `*.unlock-probe` residue; the update path waits up to ~30s (backoff) for the binary file lock.
- `cpa auto` toggles automatic startup; `cpa auto on` and `cpa auto off` set it explicitly. Explicit `off` removes active, stale, or OS-disabled registrations without requiring state inspection. Enabling requires a stable, direct npm-global MiniCPA installation; npx caches, local/source installs, and links are rejected. The registered action runs `cpa start --no-wait`; changing it does not start or stop the current process. On Windows it is a hidden WScript launcher (`wscript.exe` plus a generated `.vbs` under `%LOCALAPPDATA%\MiniCPA`), so logon no longer flashes a console window; existing direct-node registrations are detected as `stale` and repaired by an argument-free `cpa auto`. Linux uses a systemd user unit that records the effective `XDG_DATA_HOME`; it starts at login only, so a headless machine also needs `loginctl enable-linger` (an argument-free `cpa auto` prints this hint when linger is off).
- `cpa status` reports autostart as `on`, `off`, `stale`, `disabled`, or `unknown`. `stale` is an existing registration for a different launcher; an argument-free `cpa auto` repairs it. `disabled` is an otherwise current registration suppressed by the OS; an argument-free `cpa auto` re-enables it. Inspection failures become `unknown` without suppressing runtime status. The displayed CLIProxyAPI version is the last version recorded after a healthy install/restart; `status`, `version`, `doctor`, and `update check` never execute the active binary, so they cannot hold a Windows image lock against `cpa update`. On macOS an entry present in `launchctl print-disabled` with a value MiniCPA does not recognize is reported as `disabled` rather than `on`: the repair is the same single `cpa auto`, while guessing `on` would hide a registration that starts nothing.
- `cpa auto on` does not install anything — it only schedules `cpa start --no-wait`. Registering while `config.yaml` or the managed binary is missing therefore succeeds (a legitimate order for scripted setups) but prints a `Note:` naming the missing piece, because that start would otherwise fail at every login without being seen.
- Every `cpa start` records its outcome as one line in `<cpa home>/logs/minicpa.log` (`start ok pid=…` or `start failed: …`, rotated at 1 MiB, one generation kept). This exists for the autostart path: the Windows login launcher discards the process's stdout and stderr, and failures that happen before the CPA child exists — missing `config.yaml`, missing binary, a held lock — never reach `cpa.log` / `cpa.err.log` either. `cpa doctor` replays the last record when it was a failure and the registration is in force. Successes are recorded too, so an empty log means the launcher never fired rather than that it fired and worked. The file is not part of `cpa logs`, which shows CLIProxyAPI's own output.
- CLIProxyAPI is spawned **detached** and outlives the `cpa` process — including `npm uninstall -g @astralyn/minicpa`. Run `cpa stop` before removing MiniCPA; afterwards only `taskkill /PID <pid> /F` (Windows) or `kill <pid>` can end it, using the PID in `<cpa home>/state/cpa.pid`. Uninstalling never deletes `cpa root`, so `config.yaml` (with its generated api-key) and the `auths/` OAuth tokens stay on disk until you remove them.
- Uninstalling also leaves any autostart registration behind, and it keeps firing at every login against a `dist/cli.js` that no longer exists — silently on Windows, where the launcher discards output. Run `cpa auto off` **before** `npm uninstall -g`. If MiniCPA is already gone, remove the registration by hand:
  - Windows: delete the `MiniCPA` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, then `%LOCALAPPDATA%\MiniCPA\minicpa-autostart.vbs`
  - macOS: delete `~/Library/LaunchAgents/com.astralyn.minicpa.plist`
  - Linux: `systemctl --user disable minicpa.service`, then delete `~/.config/systemd/user/minicpa.service`
- `cpa start` and `cpa doctor` print warnings when `host`, `port`, or recognized `tls` fields in `config.yaml` have invalid shapes and are ignored or replaced by defaults.
- Readiness probes try `/management.html` then `/` so binary-only installs can start without a panel. They use HTTP by default and HTTPS when `tls.enable` is true; wildcard listen addresses also probe the corresponding IPv4/IPv6 loopback URL.
- On `cpa start`, logs larger than **50 MiB** are rotated to `cpa.log.1` / `cpa.err.log.1` (keeps two generations).

## Update behaviour

- The component-install phase of `cpa init` and a plain `cpa update` both install the managed CLIProxyAPI **binary + panel**. `cpa update` is used for subsequent updates; it never updates the MiniCPA npm package, so use `cpa upgrade` for that.
- Release discovery prefers `github.com/releases/latest` redirects and browser download URLs; REST API is fallback only.
- Asset names try current upstream labels (`aarch64`, `no-plugin`) then same-architecture legacy aliases (`arm64`, `portable`); 404s try the next candidate. ARM64 never falls back to an AMD64/x86_64 archive.
- Binary path: **download → checksum → extract** while CLIProxyAPI may still be running, then **stop → replace → restart** only for the install window. Network/checksum failures do **not** stop a running instance.
- On install failure, MiniCPA restores `.bak` when present (running or not). If the previous binary remains intact without needing `.bak` (for example, staging failed before replacement), its last health-verified `runtimeVersion` is preserved even when the executable version probe was temporarily unavailable; install state is cleared only when no previous binary remains on disk. If it was running: stop → restore → start.
- `cpa start` auto-recovers from crash residue: `*.unlock-probe` renames and, when the active binary is missing, the `.bak` rollback copy.
- Failures while removing temp staging after an update are reported as warnings, never as an update failure; `cpa clean` removes the residue.
- Outbound GitHub/API calls retry transient errors (429/5xx/timeouts) a few times with backoff.
- Binary integrity: downloads release `checksums.txt` and verifies the **archive** SHA-256. Panel release discovery matches the binary path (quota-free `github.com` redirect + browser download URL; REST API is fallback only), so no asset digest exists on the default path — installs then rely on content sanity checks plus the install-time SHA-256 recorded in `install.json`. When the API fallback supplies a GitHub asset SHA-256 digest, it is verified. Asset download URLs must be on GitHub/CDN hosts (`github.com`, `api.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`); off-platform URLs are rejected.
- Already-latest versions are **skipped** unless you pass `--force` (or `--version` for a specific binary tag).
- `remote-management.disable-auto-update-panel: true` suppresses the implicit panel leg of a plain `cpa update`, but not explicit installation through `cpa init`, `cpa update --panel`, or `cpa update --force`.
- `cpa update check` exits non-zero if anything is outdated **or** either check (binary / panel) errors. A panel excluded by `remote-management.disable-auto-update-panel: true` is reported as ignored and does not fail this gate.
- `--binary` and `--panel` are mutually exclusive. The older `--all` spelling remains accepted as a hidden compatibility option; a plain `cpa update` already selects both components.

## MiniCPA upgrade

- `cpa upgrade check` queries `https://registry.npmjs.org` for `@astralyn/minicpa`'s `latest` dist-tag and compares exact semantic versions. It exits 1 when an upgrade is available or the registry check fails; a local version newer than `latest` is reported and never downgraded.
- `cpa upgrade` runs only when the current executable is proven to be a writable, direct npm-global installation. It validates npm's global root and prefix, rejects links/junctions, and verifies the installed package manifest afterwards.
- A normal outdated upgrade invokes the safe equivalent of `npm update -g @astralyn/minicpa` with the detected prefix, fixed argument boundaries, `--ignore-scripts`, disabled audit/fund output, the official registry, and no shell. The installed manifest must then match the registry version exactly.
- `--force` uses an exact-version npm install to perform a real reinstall. It never authorizes a downgrade of a locally newer version.
- npx caches, `npm link`, source checkouts, project dependencies, pnpm/yarn/bun layouts, ambiguous Windows project prefixes, and read-only global installs are not rewritten automatically. Follow the reported installation-specific reason; a direct npm installation can be recovered with `npm install -g @astralyn/minicpa@latest`.
- Upgrading MiniCPA does not stop, restart, or alter the managed CLIProxyAPI process. A successful command affects subsequent `cpa` invocations.

## Temp cleanup

- `cpa clean` deletes only **old** staging entries under MiniCPA's private temp root (`cpa temp`, under `cpa root`). It never touches instance home, config, auths, or a running process. It takes the same exclusive lock as `cpa update`, so it cannot run in the middle of an update — it reports the in-flight command instead.
- `cpa doctor` reports temp size and suggests `cpa clean` when residue is large.

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| `cpa start` says HTTP/HTTPS not ready | `cpa logs --err`, check `host`, `port`, and `tls.enable` plus CLIProxyAPI certificate/key paths in `config.yaml`, then `cpa restart` |
| Port already in use | Change `port` in `config.yaml`, or stop the other process |
| `cpa web` cannot reach the panel | `cpa status` / `cpa start`; confirm `management.html` via `cpa doctor`. On a binary-only install `cpa web` reports that the web panel is not installed and points at `cpa update --panel`. When no browser launcher is available (`xdg-open` missing on a headless/WSL box), the URL is printed, a warning is written to stderr, and the command still succeeds. `cpa open` remains a compatibility alias. |
| Another cpa … is running | Wait for the other command to finish. Otherwise run `cpa doctor`: it names the lock file, the holder PID and command, when the lock was acquired, and whether the holder process is still alive. Remove `<cpa root>/state/cpa.lock` by hand when doctor reports the holder is not alive — or when doctor still shows it held but you are certain no `cpa` command is running (the lock fails closed when a live PID's identity cannot be verified, so it will not preempt itself) |
| `cpa doctor` reports lock preempt residue | `cpa.lock.preempt.*` files beside the lock are left behind when a stale-lock cleanup could not delete its copy (typically Windows `EBUSY`). Safe to delete when no `cpa` command is running |
| CPA did not start after reboot | `cpa doctor` / `cpa status` show the autostart state; `stale`/`disabled` registrations are repaired by an argument-free `cpa auto`. `cpa doctor` also replays the last recorded start failure from `<cpa home>/logs/minicpa.log` — a login start writes its outcome there because the launcher discards its console output. An empty log means the launcher never fired at all. On Linux the systemd user unit starts at login only — for a headless machine run `loginctl enable-linger` (no argument enables it for the current user) |
| Autostart went `stale` after a Node upgrade | Registrations record the absolute `node` and `dist/cli.js` paths. Under `nvm`/`fnm`/`asdf` these live inside a version-specific prefix, so switching Node versions moves both and the entry stops matching. Run an argument-free `cpa auto` to re-register against the current paths |
| Autostart registered but never runs | `cpa auto on` only schedules `cpa start --no-wait`; it does not install anything. Run `cpa init` (config) and `cpa update` (binary) — `cpa auto on` prints a note for whichever is missing, and `cpa doctor` reports the resulting start failure |
| Update checksum / integrity error | Retry; if GitHub asset is broken, temporary `--insecure` then re-check later |
| Update failed mid-way | `cpa status`; if not running, `cpa start`. Re-run `cpa update --force` if binary looks broken. `cpa doctor` if `.bak` remains |
| GitHub rate limit on update | Binary discovery prefers `github.com/releases`. Panel integrity requires GitHub release metadata; if API 403/429 occurs, set `GITHUB_TOKEN` or `GH_TOKEN`, then retry (token is not passed into CLIProxyAPI) |
| `fetch failed` / connect timeout on update | Ensure `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` are set in the same shell (profile.ps1 / bashrc). Run `cpa doctor` to confirm proxy env. Binary release metadata and assets use `github.com` by default; panel integrity metadata uses the GitHub API. MiniCPA retries transient failures automatically. |
| Binary still locked / `*.unlock-probe` | Wait for antivirus/explorer; `cpa start` recovers unlock-probe rename; retry stop/update |
| ARM update 404 | Confirm upstream published an `aarch64`/`arm64` asset for your OS. MiniCPA deliberately refuses AMD64 fallback; retry after a native asset is available. |
| `cpa upgrade` refuses the installation | It is not proven to be a writable direct npm global install. Follow the detected reason, then run `npm install -g @astralyn/minicpa@latest`; npx/link/local/source installs are intentionally not rewritten. |
| npm registry error during upgrade | Confirm HTTPS/proxy access to `registry.npmjs.org`, then retry `cpa upgrade check`. MiniCPA never sends GitHub/npm token environment variables to the public registry or npm child. |
| Large logs / temp residue | Logs rotate on next `cpa start` past 50 MiB; `cpa clean` for old temp downloads |
| Default api-key warning from doctor | Edit `api-keys` in `config.yaml` before exposing the API |
| Wrong install directory | `cpa home` / `cpa root`; MiniCPA always manages `<cpa root>/instance` |
| `init` used wrong home | MiniCPA uses only `<cpa root>/instance`; `CPA_HOME` and alternate homes are unsupported |

Useful paths:

```bash
cpa auto on  # enable automatic startup
cpa auto off # remove automatic startup deterministically
cpa home    # instance (config, binary, logs)
cpa root    # MiniCPA app data
cpa temp    # download/extract staging (safe to wipe)
cpa clean         # wipe temp only (not instance home)
cpa update check  # check CLIProxyAPI binary/web panel
cpa upgrade check # check the MiniCPA npm package
cpa doctor        # layout + binary + autostart + HTTP/HTTPS + GitHub probe
cpa logs -f       # follow stdout + stderr
```

`cpa logs` prints the last `-n, --lines <n>` lines of each log file (default `80`; must be a positive whole number). `--err` limits it to `cpa.err.log`. `-f`/`--follow` streams new output instead and ignores `--lines`; when following stdout and stderr together, prefixes are added only after a complete line arrives, so partial writes and split UTF-8 characters remain intact.
