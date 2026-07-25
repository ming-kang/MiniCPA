# MiniCPA

Thin cross-platform **`cpa`** command: layout, start/stop, open management UI, update CPA binary and `management.html`. Everything else stays in [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

MiniCPA manages **one CPA instance**. `cpa update` replaces that instance's binary and panel in place. Download and checksum happen first; a running CPA is only stopped for the brief replace window, then restarted. Already-latest installs are skipped unless you pass `--force`. Binary updates verify GitHub `checksums.txt` by default (`--insecure` skips this).

## Install

Requires **Node.js 24+**.

```bash
npm install -g @astralyn/minicpa
```

Or without a global install:

```bash
npx @astralyn/minicpa --help
```

To update MiniCPA itself:

```bash
npm install -g @astralyn/minicpa@latest
```

`cpa update` updates the managed CPA binary and management panel; it does not update MiniCPA.

## Quick start

```bash
cpa init
cpa update
cpa start
cpa open
```

**Single-instance home:** MiniCPA uses the one home shown by `cpa home`. `--home` and `CPA_HOME` are intentionally unsupported. Upgrades preserve an existing persisted home from pre-single-instance MiniCPA releases; otherwise the canonical home is created under `cpa root`.

Updates resolve binary releases via `github.com/releases` first. Panel updates fetch GitHub release metadata to require the published SHA-256 asset digest; if the GitHub API is blocked or rate-limited, set `GITHUB_TOKEN` or `GH_TOKEN`. Tokens are stripped from CPA child processes (including version probes).

**Proxy:** MiniCPA honors standard shell proxy env vars for update/network calls: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` (upper or lower case). Set them in PowerShell `$PROFILE`, bashrc, etc. — same as curl/git. `cpa doctor` prints whether a proxy is detected.

`cpa init` generates a random `api-keys` entry in `config.yaml` — still change it before public exposure. Staging files are private under MiniCPA app data; do not run `cpa clean` during an active `cpa update`.

## Paths

| Command | Windows | macOS | Linux |
|---------|---------|-------|-------|
| `cpa root` | `%LOCALAPPDATA%\MiniCPA` | `~/Library/Application Support/MiniCPA` | `$XDG_DATA_HOME/MiniCPA` or `~/.local/share/MiniCPA` |
| `cpa home` | `…\MiniCPA\instances\default` | same under root | same under root |
| `cpa temp` | `<cpa root>\temp` | `<cpa root>/temp` | `<cpa root>/temp` |

See [docs/cpa-reference.md](docs/cpa-reference.md) for startup details, single-instance migration, default config notes, and troubleshooting.

## Commands

`init` · `start` · `stop` · `restart` · `status` · `open` · `logs` · `update` / `update check` · `doctor` · `clean` · `version` · `root` · `home` · `temp`

| Command | Notes |
|---------|--------|
| `cpa start` | Waits until HTTP is ready (`--no-wait` to skip). Exclusive single-instance lock. Rotates logs ≥ 50 MiB. |
| `cpa logs` | stdout + stderr; `--err` for error log only; `-f` follow |
| `cpa update` | **Default: binary + panel.** Download/verify first, then stop/replace/restart if needed. Binary checksums and the panel's GitHub SHA-256 asset digest are required unless `--insecure` is used for the binary. |
| `cpa update --binary` / `--panel` / `--all` | Limit scope (**mutually exclusive**) |
| `cpa clean` | Wipe MiniCPA temp downloads/extract only (never touches instance home) |
| `cpa tui` | Official CPA terminal UI (must already be running) |

Errors print a short message; set `DEBUG=1` for stack traces.

## Develop

```bash
git clone https://github.com/ming-kang/MiniCPA.git
cd MiniCPA
npm install
npm test
npm run build
npm link   # optional: local global `cpa`
```

```bash
npm run typecheck
npm test
npm run build
```

## License

[MIT](LICENSE)
