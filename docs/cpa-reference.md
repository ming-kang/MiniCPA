# CPA startup conventions (MiniCPA)

MiniCPA only wraps process lifecycle and updates. Configuration and provider auth are done in CPA itself (management UI, official `-tui`, or `cli-proxy-api -config ...` flags).

When MiniCPA starts CPA:

- **Working directory** = instance directory (`cpa home`)
- **Args** = `-config <home>/config.yaml`
- **Binary** = `<home>/cli-proxy-api` (or `.exe` on Windows) — replaced in place by `cpa update`
- **Logs** = `<home>/logs/cpa.log` and `<home>/logs/cpa.err.log`

Default `config.yaml` from `cpa init` uses `auth-dir: auths` (relative to home). Optional `.env` in the same directory is loaded by CPA at startup.

OAuth, routing, api-keys, and management secrets: edit `config.yaml` / `.env` or use CPA’s management UI after `cpa open`.

## Default config notes

`cpa init` writes a starter `config.yaml` that includes:

- `api-keys: [sk-cliproxyapi]` — change before exposing the API
- `host: 127.0.0.1` / `port: 8317` — local-only by default
- `commercial-mode: true` — CPA product flag; adjust if your deployment expects otherwise

`cpa init --force` overwrites `config.yaml` after copying it to `config.yaml.bak`.

## Update behaviour

- `cpa update` replaces **binary + panel** by default.
- Already-latest versions are **skipped** unless you pass `--force` (or `--version` for a specific binary tag).
- If CPA is running, update **stops → replaces → restarts** automatically.
- If replace fails after stop, MiniCPA tries to **restart the previous binary**; if that also fails, run `cpa start` manually.

## Troubleshooting

| Symptom | What to try |
|---------|-------------|
| `cpa start` says HTTP not ready | `cpa logs --err`, check port in `config.yaml`, `cpa restart` |
| Port already in use | Change `port` in `config.yaml`, or stop the other process |
| `cpa open` cannot reach UI | `cpa status` / `cpa start`; confirm `management.html` via `cpa doctor` |
| Update failed mid-way | `cpa status`; if not running, `cpa start`. Re-run `cpa update --force` if binary looks broken |
| GitHub rate limit on update | Set `GITHUB_TOKEN`, then retry |
| Wrong install directory | `cpa home` / `cpa root`; override with `CPA_HOME` or `--home` |

Useful paths:

```bash
cpa home    # instance (config, binary, logs)
cpa root    # MiniCPA app data
cpa temp    # download/extract staging (safe to wipe)
cpa doctor  # layout + binary + HTTP + GitHub probe
cpa logs -f # follow stdout + stderr
```
