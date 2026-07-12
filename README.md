# MiniCPA

Thin cross-platform **`cpa`** command: instance layout, start/stop, open management UI, update CPA binary and `management.html`. Everything else stays in [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

## Paths (Windows)

| Command | Path |
|---------|------|
| `cpa root` | `%LOCALAPPDATA%\MiniCPA` |
| `cpa home` | `%LOCALAPPDATA%\MiniCPA\instances\default` |
| `cpa temp` | `%TEMP%\MiniCPA` (update downloads only) |

See [docs/cpa-reference.md](docs/cpa-reference.md) for how instances are started (cwd, `-config`).

## Commands

`init` · `start` · `stop` · `restart` · `status` · `open` · `logs` · `update` / `update check` / `--all` / `--panel` · `doctor` · `version` · `root` · `home` · `temp`

Optional: `cpa tui` runs the official CPA terminal UI (must already be running).

## Quick start

```bash
npm install && npm run build && npm link
cpa init
cpa update --all
cpa start
cpa open
```

Override instance: `CPA_HOME`, `cpa --home <dir>`, or `cpa init --home <dir>`.