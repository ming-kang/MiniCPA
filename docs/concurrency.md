# Concurrency & Lease Design

## Why kernel endpoints instead of lockfiles

Advisory lockfiles fail exactly where a supervisor cannot afford it:

- **Stale locks after abnormal termination**: a forcefully killed process (`kill -9`, power loss, system shutdown) leaves the lockfile behind, blocking every later command or forcing fragile steal-or-probe heuristics.
- **TOCTOU races**: probing whether a recorded PID is still alive introduces time-of-check/time-of-use windows.

MiniCPA therefore treats an operating-system IPC endpoint — a named pipe on Windows, an abstract socket on Linux, an exclusive loopback listener on macOS — as the sole mutual-exclusion authority. The kernel destroys the endpoint when its owner dies, however it dies, so a lease can never go stale, deadlock, or be stolen. Acquisition also fails closed: a command that cannot create its endpoint refuses to run rather than proceed without exclusion.

The on-disk `cpa.lock` file survives only as a diagnostic record of who holds the lease (PID, command, acquisition time), so lock-conflict errors and manual troubleshooting can name a suspect. It is never an input to the exclusion decision; a stale or corrupted record blocks nothing.

## Why two lease scopes

Downloading and verifying a release takes minutes; daemon control and status queries take seconds. A single lock would either freeze all operations for the duration of every download, or let lifecycle commands interleave with a half-finished commit. MiniCPA therefore splits exclusion into an **update lease** (everything that discovers, downloads, or prepares payloads) and a **lifecycle lease** (daemon control, plus the brief commit phase of an update). Preparation never touches the lifecycle lease, so the service stays operable while downloads are underway, and the lifecycle lease is held only for the short window in which the binary is actually replaced.

Operations that need both leases always acquire the update lease first — a fixed ordering that lets commands nest without deadlock. `cpa upgrade` holds both for its entire run: it replaces the CLI's own installation in place, so no other lease-holding operation may be in flight while npm rewrites the module tree.

## Residual risks

Kernel leases cannot deadlock or be stolen, but their endpoint names are predictable, so another local program can occupy them:

- **macOS**: the lease port derives from a hash of the state directory. An unrelated application already listening on that `127.0.0.1` port makes every `cpa` command report `Cannot acquire MiniCPA lock lease` until it releases the port. Any local user can bind loopback ports, so another account on the same Mac can also occupy it.
- **Windows**: named pipes live in a machine-wide namespace. Another local user who creates the pipe first blocks MiniCPA for the account whose state directory produced that name.
- **Linux**: abstract sockets are scoped to the network namespace. A process in a different namespace — for example a container sharing the home directory — is invisible to the lease and not excluded by it.

These are availability issues only: no path lets another process run commands as the user or bypass exclusion. The error message names the endpoint; identify its owner (`lsof -iTCP:<port>` on macOS, Sysinternals `handle` or `pipelist` on Windows) and stop it.
