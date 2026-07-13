# CPA startup conventions (MiniCPA)

MiniCPA only wraps process lifecycle and updates. Configuration and provider auth are done in CPA itself (management UI, official `-tui`, or `cli-proxy-api -config ...` flags).

When MiniCPA starts CPA:

- **Working directory** = instance directory (`cpa home`)
- **Args** = `-config <home>/config.yaml`
- **Binary** = `<home>/cli-proxy-api` (or `.exe` on Windows) — replaced in place by `cpa update`
- **Logs** = `<home>/logs/cpa.log` and `<home>/logs/cpa.err.log`
- **Child env** = parent env minus MiniCPA secrets (`GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`)

Default `config.yaml` from `cpa init` uses `auth-dir: auths` (relative to home). Optional `.env` in the same directory is loaded by CPA at startup.

OAuth, routing, api-keys, and management secrets: edit `config.yaml` / `.env` or use CPA’s management UI after `cpa open`.

## Default config notes

`cpa init` writes a starter `config.yaml` that includes:

- `api-keys: [sk-cliproxyapi]` — **change before exposing the API** (`cpa doctor` warns if still present)
- `host: 127.0.0.1` / `port: 8317` — local-only by default
- `commercial-mode: true` — CPA product flag; adjust if your deployment expects otherwise

`cpa init --force` overwrites `config.yaml` after copying it to `config.yaml.bak.<timestamp>` (previous backups are kept).

## Lifecycle and locking

- `cpa start`, `stop`, `restart`, and `update` take an exclusive lock at `<home>/state/cpa.lock`.
- If another MiniCPA command holds the lock, you get an error naming its PID — wait and retry.
- Stale locks (dead PID) are preempted automatically.
- PID ownership is fail-closed: if the process image does not look like `cli-proxy-api`, MiniCPA clears the PID file rather than stopping a foreign process.
- Windows stop: soft `taskkill /T`, grace period, then `/F`. MiniCPA waits for the binary file lock to release before replace.

## Update behaviour

- `cpa update` replaces **binary + panel** by default.
- Binary integrity: downloads release `checksums.txt` and verifies the executable SHA-256. Missing/failed checksums **abort** the update unless you pass **`--insecure`** (unsafe; for emergencies only).
- Already-latest versions are **skipped** unless you pass `--force` (or `--version` for a specific binary tag). “Current” prefers probing the on-disk binary, then install state.
- If CPA is running, update **stops → replaces → restarts** automatically.
- Previous binary is kept as `cli-proxy-api(.exe).bak` during replace. On failure after stop, MiniCPA restores the backup and tries to restart; on success the backup is removed. If restart also fails, run `cpa start` manually.
- `--binary`, `--panel`, and `--all` are mutually exclusive.

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| `cpa start` says HTTP not ready | `cpa logs --err`, check port in `config.yaml`, `cpa restart` |
| Port already in use | Change `port` in `config.yaml`, or stop the other process |
| `cpa open` cannot reach UI | `cpa status` / `cpa start`; confirm `management.html` via `cpa doctor` |
| Another cpa … is running | Wait for the other command, or remove stale `state/cpa.lock` only if that PID is dead |
| Update checksum / integrity error | Retry; if GitHub asset is broken, temporary `--insecure` then re-check later |
| Update failed mid-way | `cpa status`; if not running, `cpa start`. Re-run `cpa update --force` if binary looks broken |
| GitHub rate limit on update | Set `GITHUB_TOKEN`, then retry (token is not passed into CPA) |
| Default api-key warning from doctor | Edit `api-keys` in `config.yaml` before exposing the API |
| Wrong install directory | `cpa home` / `cpa root`; override with `CPA_HOME` or `--home` |

Useful paths:

```bash
cpa home    # instance (config, binary, logs)
cpa root    # MiniCPA app data
cpa temp    # download/extract staging (safe to wipe)
cpa doctor  # layout + binary + HTTP + GitHub probe
cpa logs -f # follow stdout + stderr
```
