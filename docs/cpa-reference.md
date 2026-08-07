# CPA startup conventions (MiniCPA)

MiniCPA only wraps process lifecycle and updates. Configuration and provider auth are done in CPA itself (management UI, official `-tui`, or `cli-proxy-api -config ...` flags).

When MiniCPA starts CPA:

- **Working directory** = the one managed instance directory (`cpa home`)
- **Args** = `-config <home>/config.yaml`
- **Binary** = `<home>/cli-proxy-api` (or `.exe` on Windows) — replaced in place by `cpa update`
- **Logs** = `<home>/logs/cpa.log` and `<home>/logs/cpa.err.log`
- **Child env** = parent env minus MiniCPA secrets (`GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_PAT`, `NPM_TOKEN`, `NPM_AUTH_TOKEN`, `NODE_AUTH_TOKEN`, …) in any environment-variable casing — including version probes via `cli-proxy-api --help`
- **Outbound HTTP (update / doctor GitHub probe)** honors shell proxy env: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (case-insensitive). `ALL_PROXY` is a fallback for both schemes **only** when it is an `http://` or `https://` URL; any other scheme (`socks5://`, …) is not applied and `cpa doctor` labels it `(scheme not applied)` — set `HTTP_PROXY`/`HTTPS_PROXY` instead. Local `cpa start` / `cpa status` readiness probes use a dedicated direct dispatcher, so they are unaffected by proxy env vars, including under `NODE_USE_ENV_PROXY` / `--use-env-proxy`.

Default `config.yaml` from `cpa init` uses `auth-dir: auths` (relative to home). Optional `.env` in the same directory is loaded by CPA at startup.

OAuth, routing, api-keys, and management secrets: edit `config.yaml` / `.env` or use CPA’s management UI after `cpa open`.

## Default config notes

`cpa init` writes a starter `config.yaml` that includes:

- a **random** `api-keys` entry stored only in `config.yaml` — rotate it before public exposure (`cpa doctor` also warns if the legacy `sk-cliproxyapi` remains)
- `host: 127.0.0.1` / `port: 8317` — local-only by default
- `commercial-mode: true` — CPA product flag; adjust if your deployment expects otherwise

`cpa init --force` overwrites `config.yaml` after copying it to `config.yaml.bak.<timestamp>` (previous backups are kept).

MiniCPA manages one instance. `cpa home` prints its location. `--home` and `CPA_HOME` are unsupported; an existing persisted home from an older MiniCPA release is honored during upgrade so the existing install remains the one managed instance.

## Lifecycle and locking

- `cpa start`, `stop`, `restart`, `init`, and `update` take one exclusive lock at `<cpa root>/state/cpa.lock` (atomic create via `O_EXCL` / `wx`).
- If another MiniCPA command holds the lock, you get an error naming its PID — wait and retry.
- Stale locks (dead PID, or PID reuse detected via a process start marker) are preempted safely: the lock is renamed aside, its content re-verified against the stale decision, and only then removed. A freshly created but not-yet-written lock is waited out, never deleted.
- PID ownership requires an exact executable-path match **or** a matching spawn-time start marker (boot id + process start time, immune to PID reuse). If neither can be verified, MiniCPA preserves the PID record to avoid a duplicate start and **refuses to terminate the process**.
- Stop waits for process death after force-kill before clearing the PID file. `cpa stop` no longer waits for the binary **file** to become unlocked — that wait belongs to `cpa update`, which performs it before replacing the binary.
- Windows stop: soft `taskkill /T`; when the graceful signal cannot be delivered (typical for the windowless background process), MiniCPA force-kills immediately instead of waiting out the grace period, so stop completes in about a second. Unlock probes recover `*.unlock-probe` residue; the update path waits up to ~30s (backoff) for the binary file lock.
- CPA is spawned **detached** and outlives the `cpa` process — including `npm uninstall -g @astralyn/minicpa`. Run `cpa stop` before removing MiniCPA; afterwards only `taskkill /PID <pid> /F` (Windows) or `kill <pid>` can end it, using the PID in `<cpa home>/state/cpa.pid`. Uninstalling never deletes `cpa root`, so `config.yaml` (with its generated api-key) and the `auths/` OAuth tokens stay on disk until you remove them.
- `cpa start` and `cpa doctor` print warnings when `host`/`port` in `config.yaml` are invalid and defaults were substituted.
- Readiness probes try `/management.html` then `/` so binary-only installs can start without a panel.
- On `cpa start`, logs larger than **50 MiB** are rotated to `cpa.log.1` / `cpa.err.log.1` (keeps two generations).

## Update behaviour

- `cpa update` replaces **binary + panel** by default.
- Release discovery prefers `github.com/releases/latest` redirects and browser download URLs; REST API is fallback only.
- Asset names try current upstream labels (`aarch64`, `no-plugin`) then legacy aliases (`arm64`, `portable`); 404s try the next candidate.
- Binary path: **download → checksum → extract** while CPA may still be running, then **stop → replace → restart** only for the install window. Network/checksum failures do **not** stop a running instance.
- On install failure, MiniCPA restores `.bak` when present (running or not) and rewrites the prior `runtimeVersion` **only when the restore succeeded** — install state never claims a version with no binary on disk. If it was running: stop → restore → start.
- `cpa start` auto-recovers from crash residue: `*.unlock-probe` renames and, when the active binary is missing, the `.bak` rollback copy.
- Failures while removing temp staging after an update are reported as warnings, never as an update failure; `cpa clean` removes the residue.
- Outbound GitHub/API calls retry transient errors (429/5xx/timeouts) a few times with backoff.
- Binary integrity: downloads release `checksums.txt` and verifies the **archive** SHA-256. Panel updates fetch GitHub release metadata and require the published asset SHA-256 digest; a missing digest fails closed. Asset download URLs from the GitHub API must be on GitHub/CDN hosts (`github.com`, `api.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`); off-platform URLs are rejected.
- Already-latest versions are **skipped** unless you pass `--force` (or `--version` for a specific binary tag).
- `cpa update check` exits non-zero if anything is outdated **or** the panel check errors.
- `--binary`, `--panel`, and `--all` are mutually exclusive.

## Temp cleanup

- `cpa clean` deletes only **old** staging entries under MiniCPA's private temp root (`cpa temp`, under `cpa root`). It never touches instance home, config, auths, or a running process. It takes the same exclusive lock as `cpa update`, so it cannot run in the middle of an update — it reports the in-flight command instead.
- `cpa doctor` reports temp size and suggests `cpa clean` when residue is large.

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| `cpa start` says HTTP not ready | `cpa logs --err`, check port in `config.yaml`, `cpa restart` |
| Port already in use | Change `port` in `config.yaml`, or stop the other process |
| `cpa open` cannot reach UI | `cpa status` / `cpa start`; confirm `management.html` via `cpa doctor`. On a binary-only install `cpa open` reports that the management panel is not installed and points at `cpa update --panel`. When no browser launcher is available (`xdg-open` missing on a headless/WSL box), the URL is printed, a warning is written to stderr, and the command still succeeds |
| Another cpa … is running | Wait for the other command to finish. Otherwise run `cpa doctor`: it names the lock file, the holder PID and command, when the lock was acquired, and whether the holder process is still alive. Remove `<cpa root>/state/cpa.lock` by hand when doctor reports the holder is not alive — or when doctor still shows it held but you are certain no `cpa` command is running (the lock fails closed when a live PID's identity cannot be verified, so it will not preempt itself) |
| `cpa doctor` reports lock preempt residue | `cpa.lock.preempt.*` files beside the lock are left behind when a stale-lock cleanup could not delete its copy (typically Windows `EBUSY`). Safe to delete when no `cpa` command is running |
| Update checksum / integrity error | Retry; if GitHub asset is broken, temporary `--insecure` then re-check later |
| Update failed mid-way | `cpa status`; if not running, `cpa start`. Re-run `cpa update --force` if binary looks broken. `cpa doctor` if `.bak` remains |
| GitHub rate limit on update | Binary discovery prefers `github.com/releases`. Panel integrity requires GitHub release metadata; if API 403/429 occurs, set `GITHUB_TOKEN` or `GH_TOKEN`, then retry (token is not passed into CPA) |
| `fetch failed` / connect timeout on update | Ensure `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` are set in the same shell (profile.ps1 / bashrc). Run `cpa doctor` to confirm proxy env. Binary release metadata and assets use `github.com` by default; panel integrity metadata uses the GitHub API. MiniCPA retries transient failures automatically. |
| Binary still locked / `*.unlock-probe` | Wait for antivirus/explorer; `cpa start` recovers unlock-probe rename; retry stop/update |
| ARM update 404 | Ensure you are on a MiniCPA build that tries `aarch64` asset names; retry `cpa update` |
| Large logs / temp residue | Logs rotate on next `cpa start` past 50 MiB; `cpa clean` for old temp downloads |
| Default api-key warning from doctor | Edit `api-keys` in `config.yaml` before exposing the API |
| Wrong install directory | `cpa home` / `cpa root`; MiniCPA manages one canonical home (or preserves the one persisted by an older release) |
| `init` used wrong home | MiniCPA uses one canonical home; inspect it with `cpa home` and migrate any older persisted installation before initializing |

Useful paths:

```bash
cpa home    # instance (config, binary, logs)
cpa root    # MiniCPA app data
cpa temp    # download/extract staging (safe to wipe)
cpa clean   # wipe temp only (not instance home)
cpa doctor  # layout + binary + HTTP + GitHub probe
cpa logs -f # follow stdout + stderr
```

`cpa logs` prints the last `-n, --lines <n>` lines of each log file (default `80`; must be a positive whole number). `--err` limits it to `cpa.err.log`. `-f`/`--follow` streams new output instead and ignores `--lines`.
