# CPA startup conventions (MiniCPA)

MiniCPA only wraps process lifecycle and updates. Configuration and provider auth are done in CPA itself (management UI, official `-tui`, or `cli-proxy-api -config ...` flags).

When MiniCPA starts CPA:

- **Working directory** = the one managed instance directory (`cpa home`)
- **Args** = `-config <home>/config.yaml`
- **Binary** = `<home>/cli-proxy-api` (or `.exe` on Windows) — replaced in place by `cpa update`
- **Logs** = `<home>/logs/cpa.log` and `<home>/logs/cpa.err.log`
- **Child env** = parent env minus MiniCPA secrets (`GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_PAT`, `NPM_TOKEN`, `NPM_AUTH_TOKEN`, `NODE_AUTH_TOKEN`, …) in any environment-variable casing — including version probes via `cli-proxy-api --help`
- **Outbound HTTP (update / doctor GitHub probe)** honors shell proxy env: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (case-insensitive). Local `cpa start` readiness checks stay direct to loopback and do not use the proxy.

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
- Stale locks (dead PID) are preempted automatically, then re-claimed with exclusive create.
- PID ownership requires an exact executable-path match. If MiniCPA cannot verify ownership, it preserves the PID record to avoid a duplicate start and **refuses to terminate the process**.
- Stop waits for process death after force-kill before clearing the PID file.
- Windows stop: soft `taskkill /T`, grace period, then `/F`. Unlock probes recover `*.unlock-probe` residue. MiniCPA waits up to ~30s (backoff) for the binary file lock; if still locked, the command fails with a clear error.
- Readiness probes try `/management.html` then `/` so binary-only installs can start without a panel.
- On `cpa start`, logs larger than **50 MiB** are rotated to `cpa.log.1` / `cpa.err.log.1` (keeps two generations).

## Update behaviour

- `cpa update` replaces **binary + panel** by default.
- Release discovery prefers `github.com/releases/latest` redirects and browser download URLs; REST API is fallback only.
- Asset names try current upstream labels (`aarch64`, `no-plugin`) then legacy aliases (`arm64`, `portable`); 404s try the next candidate.
- Binary path: **download → checksum → extract** while CPA may still be running, then **stop → replace → restart** only for the install window. Network/checksum failures do **not** stop a running instance.
- On install failure, MiniCPA restores `.bak` when present (running or not), rewrites prior `runtimeVersion`, and if it was running: stop → restore → start.
- Outbound GitHub/API calls retry transient errors (429/5xx/timeouts) a few times with backoff.
- Binary integrity: downloads release `checksums.txt` and verifies the **archive** SHA-256. Panel updates fetch GitHub release metadata and require the published asset SHA-256 digest; a missing digest fails closed.
- Already-latest versions are **skipped** unless you pass `--force` (or `--version` for a specific binary tag).
- `cpa update check` exits non-zero if anything is outdated **or** the panel check errors.
- `--binary`, `--panel`, and `--all` are mutually exclusive.

## Temp cleanup

- `cpa clean` deletes only **old** staging entries under MiniCPA's private temp root (`cpa temp`, under `cpa root`). It never touches instance home, config, auths, or a running process. Avoid cleaning during an active update.
- `cpa doctor` reports temp size and suggests `cpa clean` when residue is large.

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| `cpa start` says HTTP not ready | `cpa logs --err`, check port in `config.yaml`, `cpa restart` |
| Port already in use | Change `port` in `config.yaml`, or stop the other process |
| `cpa open` cannot reach UI | `cpa status` / `cpa start`; confirm `management.html` via `cpa doctor` |
| Another cpa … is running | Wait for the other command, or remove stale `state/cpa.lock` only if that PID is dead |
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
