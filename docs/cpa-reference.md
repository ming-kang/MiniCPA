# MiniCPA CLI reference

MiniCPA bootstraps one local CLIProxyAPI instance, manages its process and binary, and launches its interfaces. **Configuration belongs to CPA after the first creation.** MiniCPA does not parse configuration, enforce defaults, manage configuration history, or restore configuration during binary recovery.

## First use and configuration ownership

```bash
npm install -g @astralyn/minicpa
cpa init
cpa start
cpa web
```

`cpa init` creates `<home>/config.yaml` only when absent, using exclusive creation. Its entire initial content is limited to:

- loopback listening at `127.0.0.1:8317`;
- the relative authentication directory `auths`;
- the client bootstrap key `sk-cliproxyapi`;
- local-only management using `CLIPROXYAPI`, with the `seakee/CPA-Manager-Plus` panel enabled and automatically updated.

These are public bootstrap keys. Replace them in CPA during initial setup before authorizing sensitive accounts or exposing the service. MiniCPA does not generate random keys, add TLS/logging/routing/provider defaults, ship `config.example.yaml`, or create `.env`.

An existing config is never read or overwritten by initialization, even when empty, malformed, too large for older MiniCPA limits, or created concurrently. Re-running init only ensures the latest binary is installed. Download failures leave the generated config and later user edits intact. If a configuration write or flush fails, initialization fails and preserves the created path rather than deleting a possible concurrent writer's data; inspect that file before retrying.

`init --force` is removed. `update --force` reinstalls the binary only. Existing fixed-slot, timestamped, manual, and atomic-recovery configuration backups are left alone: MiniCPA neither reads nor deletes them. Their retention and restoration are the user's responsibility.

Only the application home and MiniCPA state directories are prepared by initialization. CPA creates and owns its authentication, native logs, and static-asset directories. MiniCPA does not recursively repair their permissions or chmod existing CPA config, `.env`, credentials or backups. Its own directories/new state files remain private (`0700`/`0600` on POSIX).

## Working directory, arguments and connection target

- **Home:** the single `<cpa root>/instance` directory printed by `cpa home`.
- **Working directory:** home.
- **Server arguments:** `-config <home>/config.yaml`.
- **TUI arguments:** the same config path plus `-tui`; the official CPA program handles its own configuration and terminal connection.
- **Binary:** `<home>/cli-proxy-api` (or `.exe` on Windows), replaced in place by updates.
- **Detached output:** stdout/stderr discarded. Native file logging is controlled by CPA.
- **MiniCPA events:** `<home>/state/minicpa.log`, separate from native logs.

`--home`, `CPA_HOME` and persisted home selection are unsupported. Root paths use the branded MiniCPA namespace under local application data on Windows, Application Support on macOS, and XDG data home on Linux.

MiniCPA's Web launcher, HTTP status and startup/restart probes default to `http://127.0.0.1:8317`. This is an explicit connection target, **not a reading of the current CPA configuration**. For a non-default listener or HTTPS:

```bash
cpa --api-url https://127.0.0.1:9443 start
cpa --api-url https://127.0.0.1:9443 restart
cpa --api-url https://127.0.0.1:9443 status
cpa --api-url https://127.0.0.1:9443 web
cpa --api-url https://127.0.0.1:9443 update
```

The global option must precede the command. `MINICPA_API_URL` provides an environment fallback; an explicit option wins. The URL must be an HTTP(S) base without credentials, query or fragment. IPv6 and reverse-proxy prefixes are accepted. This option never changes CPA's server configuration, and the native TUI continues using its own configuration.

## Lifecycle and locking

Lifecycle mutations use a kernel-owned lease with the diagnostic record `<cpa root>/state/cpa.lock`. Update/init preparation and temporary-file cleanup use another lease at `<cpa root>/state/update/cpa.lock`. Package-upgrade installation takes preparation before lifecycle, so it cannot replace modules during an active binary preparation. Leases use named pipes on Windows, abstract Unix sockets on Linux, and exclusive loopback listeners on macOS; endpoint ownership survives deletion of the diagnostic file.

Busy operations report the holder and are not preempted. Reentrancy is restricted to the owning async operation. Stale/corrupt lock records are recovered only while owning the kernel lease, comparing the original record directly. Different MiniCPA versions should not run concurrently during upgrades.

Process ownership requires the exact executable identity or a comparable spawn-time start marker. Unknown identity retains the PID record and prevents termination of an unverified process. Read-only status/doctor/TUI lookups never repair stale process records or rename binary residue.

`start` waits for the connection target unless `--no-wait` is supplied. Probes prefer `/` and retain `/management.html` as a fallback, under one total deadline. They bypass environment proxies and accept self-signed CPA certificates through an isolated dispatcher; download certificate verification is unchanged.

`restart` and updating a running instance no longer pre-validate YAML. CPA loads its own file and determines whether it can start. MiniCPA does not repair config errors or undo CPA's migrations. Supply the right connection URL when waiting for a changed listener.

Stop verifies ownership immediately before destructive signals and waits for process death before clearing its record. Windows tries graceful `taskkill /T`, then force-kills when needed. Plain stop does not wait for executable-file unlock; only an update needs that probe. A crashed `.unlock-probe` name or missing active binary with a `.bak` is recoverable on the locked lifecycle path.

## Binary update and recovery

Preparation is release discovery → download → existing archive SHA-256 verification → safe extraction → target-volume copy/fsync. These stages hold no lifecycle lock and do not stop a running server. Network, checksum, extraction or copy failures leave the current process intact.

Commit takes the lifecycle lease, re-reads the actual binary/process state, and performs stop → unlock → replace → restart only when replacement is needed. A user start or stop during preparation is respected. Already-current versions skip download/replacement unless a force or explicit version is requested.

No update path reads, synchronizes, backs up, cleans up, or rolls back configuration. Configuration edits and migrations made by CPA remain intact even if the new binary fails. Binary recovery uses only the backup made by that operation, never an older stale backup. Install-metadata repair failure does not prevent an available previous binary's restart attempt. Downgrades or native config migrations may require the user to prepare a compatible configuration; binary recovery is not a multi-file configuration transaction.

Release discovery prefers public browser redirects/downloads, with REST fallback. Asset candidates remain architecture-specific; ARM64 never falls back to AMD64. Archive checksums are mandatory unless the explicitly unsafe `--insecure` option is used. Existing GitHub/CDN URL restrictions, streaming extraction and archive bounds are retained, without new integrity/hash schemes.

`update check` checks the binary only and exits 1 for an outdated binary or failed check. Legacy `--all`/`--binary` remain binary aliases. `--panel` prints guidance because CPA owns Web asset provisioning, periodic replacement and integrity policy. The Web launcher may wait for first-access provisioning; it does not inspect panel settings to guess why a route is unavailable.

## Native logs, events and doctor

`logs` reads native `logs/main.log`, with a default tail of 80 lines. `--err` selects the ten newest `error-*.log` request-error files. Following detects replacement/new error files and preserves UTF-8 and partial lines with backpressure. Shell `WRITABLE_PATH` / `writable_path` overrides are honored; CPA's `.env` is not read by MiniCPA.

**The bootstrap does not enable application file logging.** Configure it in CPA if retained application logs are required. New starts do not write permanent stdout/stderr captures; raw panic/stderr output outside native logging is not retained. Old processes keep old descriptors until restarted, and `logs --legacy` remains a read-only history path. Missing native files trigger a warned legacy fallback when old captures exist.

Every `start` records success or failure in `<home>/state/minicpa.log`, outside upstream cleanup. The event file uses a 1 MiB threshold and one rotated generation; blocked rotation prevents unlimited appends. Doctor can read old `logs/minicpa.log` until the new event path has history.

Doctor checks configuration presence, not syntax, size, weak keys, TLS fields or panel switches. It inspects the binary/version metadata, process, own state permissions, autostart, connection target, and staging. Windows uses a transient `.minicpa-write-probe` to test directory writability. It never executes the active CPA binary for read-only version reporting or repairs CPA files.

Doctor's optional GitHub probe makes one attempt under a three-second total budget. Recursive staging statistics require `--deep`. Metadata/checksum/archive budgets remain 1 MiB, 256 KiB and 512 MiB respectively, with 10,000 archive entries, 32 path components and an actual TAR decompression limit. Configuration-text loading and its former 4 MiB limit are removed.

## Autostart, package upgrades and cleanup

`auto` toggles login startup; `auto on/off` set it explicitly. A stable direct npm-global installation is required to enable it. Registration targets `cpa start --no-wait`, changes only future startup and installs nothing. Missing binary/config produces a note rather than failing registration. Startup skips HTTP readiness, so scheduling a non-default CPA listener does not require a separate HTTP probe target.

Registration states are `on`, `off`, `stale`, `disabled`, or `unknown`. Argument-free auto repairs stale/OS-disabled registration. Windows uses `%LOCALAPPDATA%/MiniCPA/minicpa-autostart.vbs` and the HKCU MiniCPA Run/StartupApproved entries. Linux uses `~/.config/systemd/user/minicpa.service`; headless startup may also need `loginctl enable-linger`. macOS uses `~/Library/LaunchAgents/com.astralyn.minicpa.plist`.

`upgrade` targets only MiniCPA. It compares npm versions, proves a writable direct global installation, runs the fixed safe npm update/install command with scripts disabled and credentials removed, then verifies the installed manifest. A newer local version is never downgraded. Npx caches, source/link/project dependencies and ambiguous or foreign package-manager layouts are refused. Upgrading MiniCPA does not rewrite CPA configuration or stop/restart its process.

Each binary preparation uses a private `<cpa temp>/operations/update-<id>` directory. Cleanup runs asynchronously outside lifecycle locking, without preliminary recursive size scans. An exclusive preparation lease proves prior operation roots are orphaned; remove them before another preparation, refusing growth if deletion is blocked. Automatic legacy maintenance scans at most 32 candidates; explicit `clean` scans all and judges each download by its own age. Temp boundaries refuse symlink/junction escapes. Configuration and its backup directories are outside these cleanup paths.

## Troubleshooting and uninstall

| Symptom | Action |
|---------|--------|
| Missing config on a new machine | `cpa init`, then `cpa start` |
| Configuration error or an incomplete initial write | Review the file at `cpa home`; obtain the error from CPA itself, not a MiniCPA validator |
| Server is alive but HTTP is not reachable | Check the explicit API URL and use `--api-url` / `MINICPA_API_URL` for a changed listener |
| No application logs after first setup | Enable retained native logging in CPA; MiniCPA does not add defaults |
| Web panel unavailable | Check CPA's own settings/network/logs; it owns panel provisioning |
| Update failure after native config migration | Review native configuration compatibility; MiniCPA rolls back only its binary |
| Stale/OS-disabled autostart | Run `cpa auto` to repair; use `cpa auto off` for deterministic removal |
| Held lock or blocked staging cleanup | Inspect `cpa doctor`; do not remove active operation data |
| Unrecorded runtime version | `cpa update --force`; read-only commands do not execute the active binary |

CPA outlives MiniCPA uninstallation. Run `cpa auto off` and `cpa stop` first, then record `cpa home`/`cpa root` and uninstall the npm package. If already uninstalled, stop the recorded PID manually and remove the user autostart registration. Configuration, credentials, native logs, backups and instance data are never deleted by npm uninstall; remove app data only after the process has stopped and needed data has been preserved.
