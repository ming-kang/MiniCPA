# MiniCPA

Thin cross-platform **`cpa`** command: layout, start/stop, open the management UI, update CPA, and upgrade MiniCPA itself. Everything else stays in [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

MiniCPA manages **one CPA instance**. `cpa update` replaces that instance's CLIProxyAPI binary and panel in place. Download and checksum happen first; a running CPA is only stopped for the brief replace window, then restarted. Already-latest installs are skipped unless you pass `--force`. Binary updates verify GitHub `checksums.txt` by default (`--insecure` skips this). `cpa upgrade` is separate and updates the globally installed `@astralyn/minicpa` npm package without touching the running CPA instance.

## Install

Requires **Node.js 24+** (older Node versions exit immediately with a clear error).

```bash
npm install -g @astralyn/minicpa
```

Or without a global install:

```bash
npx @astralyn/minicpa --help
```

For a direct npm global installation, update MiniCPA itself with:

```bash
cpa upgrade check
cpa upgrade
```

`cpa upgrade` only modifies an installation that MiniCPA can prove is a writable, direct npm global package. It refuses to rewrite npx caches, `npm link`, source checkouts, project dependencies, or pnpm/yarn/bun installations. In those cases—or if the automatic upgrade fails—run:

```bash
npm install -g @astralyn/minicpa@latest
```

`cpa update` updates the managed CPA binary and management panel; it never updates MiniCPA.

## Uninstall

CPA runs detached, so it keeps running after MiniCPA is removed. Stop it **before** uninstalling, and note the data paths while `cpa` is still available:

```bash
cpa stop
cpa home   # instance: config.yaml (api key), auths/ (provider OAuth tokens), logs
cpa root   # MiniCPA app data (contains the instance and temp staging)
npm uninstall -g @astralyn/minicpa
```

If you uninstall first, CPA is still listening (`127.0.0.1:8317` by default) and only the OS can stop it — `taskkill /PID <pid> /F` on Windows, `kill <pid>` elsewhere; the PID is in `<cpa home>/state/cpa.pid`.

Uninstalling never deletes CPA data. Delete the `cpa root` directory by hand once CPA is stopped if you want the generated api-key and the `auths/` OAuth tokens gone.

## Quick start

```bash
cpa init
cpa update
cpa start
cpa open
```

**Single-instance home:** MiniCPA uses the one home shown by `cpa home`. `--home` and `CPA_HOME` are intentionally unsupported. Upgrades preserve an existing persisted home from pre-single-instance MiniCPA releases; otherwise the canonical home is created under `cpa root`.

Updates resolve binary releases via `github.com/releases` first. Panel updates fetch GitHub release metadata to require the published SHA-256 asset digest; if the GitHub API is blocked or rate-limited, set `GITHUB_TOKEN` or `GH_TOKEN`. Tokens are stripped from CPA child processes (including version probes).

**Proxy:** MiniCPA honors standard shell proxy env vars for GitHub and npm update checks: `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (upper or lower case). `ALL_PROXY` is used as a fallback for both HTTP and HTTPS, but only when its scheme is `http://` or `https://`; a `socks5://` `ALL_PROXY` is **not** applied — set `HTTP_PROXY`/`HTTPS_PROXY` instead. Set them in PowerShell `$PROFILE`, bashrc, etc. — same as curl/git. `cpa doctor` prints the detected proxy env and labels an `ALL_PROXY` it cannot use with `(scheme not applied)`. Local CPA readiness probes bypass proxy settings; when `tls.enable: true`, they use HTTPS and accept a self-signed certificate only in that isolated local probe.

`cpa init` generates a random `api-keys` entry in `config.yaml` — still change it before public exposure. Staging files are private under MiniCPA app data. `cpa clean`, CPA-mutating lifecycle commands, `cpa update`, and an installing `cpa upgrade` share the same exclusive lock, so package and instance changes cannot overlap — the blocked command reports the in-flight command instead.

## Paths

| Command | Windows | macOS | Linux |
|---------|---------|-------|-------|
| `cpa root` | `%LOCALAPPDATA%\MiniCPA` | `~/Library/Application Support/MiniCPA` | `$XDG_DATA_HOME/MiniCPA` or `~/.local/share/MiniCPA` |
| `cpa home` | `…\MiniCPA\instances\default` | same under root | same under root |
| `cpa temp` | `<cpa root>\temp` | `<cpa root>/temp` | `<cpa root>/temp` |

See [docs/cpa-reference.md](docs/cpa-reference.md) for startup details, single-instance migration, default config notes, and troubleshooting. Release notes are in [CHANGELOG.md](CHANGELOG.md).

## Commands

`init` · `start` · `stop` · `restart` · `status` · `open` · `logs` · `update` / `update check` · `upgrade` / `upgrade check` · `doctor` · `clean` · `version` · `root` · `home` · `temp`

| Command | Notes |
|---------|--------|
| `cpa start` | Waits until HTTP/HTTPS is ready (`--no-wait` to skip). Exclusive single-instance lock. Rotates logs ≥ 50 MiB. Warns on invalid `host`/`port`/`tls` values in config.yaml. |
| `cpa stop` | Stops the process only — it does not wait for the binary file to unlock (update handles that), so Windows stop is fast. |
| `cpa status` | Read-only summary (no lock). Exit 1 when not running or the configured HTTP/HTTPS endpoint is not reachable. |
| `cpa logs` | stdout + stderr; `-n, --lines <n>` last lines per file (default `80`, must be a positive whole number); `--err` for error log only; `-f` follow (ignores `--lines`) |
| `cpa update` | **Default: binary + panel.** Download/verify first, then stop/replace/restart if needed. Binary checksums and the panel's GitHub SHA-256 asset digest are required unless `--insecure` is used for the binary. A panel failure after a successful binary update is reported as a warning — retry with `cpa update --panel`. |
| `cpa update --binary` / `--panel` / `--all` | Limit scope (**mutually exclusive**) |
| `cpa update check` | Report CLIProxyAPI binary/panel current vs latest. Exit 1 when anything is outdated **or** a check errors. |
| `cpa upgrade` | Update MiniCPA from npm when running from a proven direct global npm install. `--force` reinstalls the current latest version but never downgrades a locally newer version. Does not stop or restart CPA. |
| `cpa upgrade check` | Report MiniCPA current vs npm latest without modifying the installation. Exit 1 when outdated or the registry check fails. |
| `cpa doctor` | Read-only diagnostics. Exit 1 when any check fails. |
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
