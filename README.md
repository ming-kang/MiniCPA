# MiniCPA

Thin cross-platform **`cpa`** command: layout, start/stop, open management UI, update CPA binary and `management.html`. Everything else stays in [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

One install by default. **`cpa update` replaces the binary and panel in place.** If CPA is running, it stops, replaces, and restarts. Already-latest installs are skipped unless you pass `--force`.

## Paths

| Command | Windows | macOS | Linux |
|---------|---------|-------|-------|
| `cpa root` | `%LOCALAPPDATA%\MiniCPA` | `~/Library/Application Support/MiniCPA` | `$XDG_DATA_HOME/MiniCPA` or `~/.local/share/MiniCPA` |
| `cpa home` | `…\MiniCPA\instances\default` | same under root | same under root |
| `cpa temp` | `%TEMP%\MiniCPA` | OS temp `/MiniCPA` | OS temp `/MiniCPA` |

See [docs/cpa-reference.md](docs/cpa-reference.md) for startup details, default config notes, and troubleshooting.

## Commands

`init` · `start` · `stop` · `restart` · `status` · `open` · `logs` · `update` / `update check` · `doctor` · `version` · `root` · `home` · `temp`

| Command | Notes |
|---------|--------|
| `cpa start` | Waits until HTTP is ready (`--no-wait` to skip) |
| `cpa logs` | stdout + stderr; `--err` for error log only; `-f` follow |
| `cpa update` | **Default: binary + panel.** Skips if current. `--force` reinstall. Running → stop/replace/restart. |
| `cpa update --binary` / `--panel` | Limit scope (mutually exclusive) |
| `cpa tui` | Official CPA terminal UI (must already be running) |

Errors print a short message; set `DEBUG=1` for stack traces.

## Quick start

```bash
npm install && npm run build && npm link
cpa init
cpa update
cpa start
cpa open
```

Override home: `CPA_HOME`, `cpa --home <dir>`, or `cpa init --home <dir>`.

Optional: set `GITHUB_TOKEN` to avoid GitHub API rate limits during updates.

## Develop

```bash
npm run typecheck
npm test
npm run build
```
