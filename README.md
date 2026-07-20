# MiniCPA

Thin cross-platform **`cpa`** command: layout, start/stop, open management UI, update CPA binary and `management.html`. Everything else stays in [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

One install by default. **`cpa update` replaces the binary and panel in place.** Download and checksum happen first; a running CPA is only stopped for the brief replace window, then restarted. Already-latest installs are skipped unless you pass `--force`. Binary updates verify GitHub `checksums.txt` by default (`--insecure` skips this).

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

**Home resolution** (first match wins): `--home` (before or after the subcommand) → `CPA_HOME` → MiniCPA `config.json` → default instance under `cpa root`.

Examples: `cpa --home D:\cpa init`, `cpa doctor --home D:\cpa`, `CPA_HOME=D:\cpa cpa start`.

Updates resolve and download public releases via `github.com/releases` (no REST rate limit). Optional: set `GITHUB_TOKEN` or `GH_TOKEN` only if the browser path is blocked and MiniCPA must fall back to the GitHub API. Tokens are stripped from CPA child processes (including version probes).

**Proxy:** MiniCPA honors standard shell proxy env vars for update/network calls: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` (upper or lower case). Set them in PowerShell `$PROFILE`, bashrc, etc. — same as curl/git. `cpa doctor` prints whether a proxy is detected.

`cpa init` generates a random `api-keys` entry in `config.yaml` — still change it before public exposure. Do not run `cpa clean` during an active `cpa update` (clean only removes temp entries older than ~1 hour).

## Paths

| Command | Windows | macOS | Linux |
|---------|---------|-------|-------|
| `cpa root` | `%LOCALAPPDATA%\MiniCPA` | `~/Library/Application Support/MiniCPA` | `$XDG_DATA_HOME/MiniCPA` or `~/.local/share/MiniCPA` |
| `cpa home` | `…\MiniCPA\instances\default` | same under root | same under root |
| `cpa temp` | `%TEMP%\MiniCPA` | OS temp `/MiniCPA` | OS temp `/MiniCPA` |

See [docs/cpa-reference.md](docs/cpa-reference.md) for startup details, default config notes, and troubleshooting.

## Commands

`init` · `start` · `stop` · `restart` · `status` · `open` · `logs` · `update` / `update check` · `doctor` · `clean` · `version` · `root` · `home` · `temp`

| Command | Notes |
|---------|--------|
| `cpa start` | Waits until HTTP is ready (`--no-wait` to skip). Exclusive home lock. Rotates logs ≥ 50 MiB. |
| `cpa logs` | stdout + stderr; `--err` for error log only; `-f` follow |
| `cpa update` | **Default: binary + panel.** Download/verify first, then stop/replace/restart if needed. Skips if current. `--force` reinstall. Checksums required unless `--insecure`. |
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
