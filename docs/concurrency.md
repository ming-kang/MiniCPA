# Concurrency & Dual-Lease Architecture

MiniCPA coordinates multiple CLI commands, background processes, and asynchronous staging tasks using an operating-system-level dual-lease concurrency model.

---

## 1. Architectural Motivation

Traditional CLI tools often rely on advisory file locking (such as lockfiles with stored PIDs or flock/fcntl locks). These approaches suffer from fundamental limitations across platforms:

- **Deadlock from abnormal termination**: If a process is forcefully killed (`kill -9`, power failure, or system shutdown), stale lockfiles remain on disk, blocking subsequent commands indefinitely.
- **Race conditions during inspection**: Probing whether an on-disk PID is still alive introduces time-of-check to time-of-use (TOCTOU) races.
- **Unnecessary operational blocking**: Long operations like downloading release archives or calculating directory statistics do not need to block short operational commands like querying service status or stopping a daemon.

To eliminate these issues, MiniCPA decouples concurrency authority from filesystem state and divides operations into two distinct synchronization scopes.

---

## 2. Kernel-Owned Lease Authority

MiniCPA delegates exclusive mutual exclusion directly to kernel IPC endpoints:

```
                      +-------------------------------------------+
                      |             MiniCPA Process               |
                      +---------------------+---------------------+
                                            |
                         Acquires Lease via | Kernel Endpoint
                                            v
     Windows: Named Pipe          Linux: Abstract Socket         macOS: Exclusive Loopback
  (\\.\pipe\minicpa-<hash>)          (\0minicpa-<hash>)           (127.0.0.1:<derived-port>)
```

### Platform Endpoint Implementations

| Platform | Mechanism | Endpoint Topology | Automatic Cleanup Guarantee |
|----------|-----------|-------------------|-----------------------------|
| **Windows** | Named Pipe Server | `\\.\pipe\minicpa-<hash>` | Closed immediately by the Windows kernel upon process death |
| **Linux** | Abstract Unix Socket | `\0minicpa-<hash>` | Exists only in the network namespace; disappears on process exit |
| **macOS** | Exclusive Loopback Server | `127.0.0.1:<port>` | Sockets close automatically on termination; port derived from instance hash |

### Diagnostic Record Decoupling

The on-disk lock file (`state/cpa.lock`) is strictly an auxiliary diagnostic artifact:
- It records human-readable metadata: PID, executing command, and acquisition timestamp.
- **The kernel endpoint is the sole authority**: An available kernel lease permits execution even if an on-disk diagnostic file exists, is stale, or is corrupted.

---

## 3. Dual-Lease Scope Topology

MiniCPA separates mutual exclusion into two distinct leases to maximize service availability during updates and maintenance:

```
               +---------------------------------------------------------+
               |                     Dual Leases                         |
               +----------------------------+----------------------------+
                                            |
                    +-----------------------+-----------------------+
                    |                                               |
                    v                                               v
         [ Lifecycle Lease ]                               [ Update Lease ]
     Endpoint: minicpa-<hash>                         Endpoint: minicpa-<hash>-update
     Scope:                                           Scope:
       - start, stop, restart                           - Release discovery & download
       - Commit phase of binary update                  - SHA-256 verification & extraction
       - Self-upgrade package execution                 - Stale staging cleanup (per update)
```

### Scope Interactions & Reentrancy

1. **Independent Preparation**: Downloading a new binary or cleaning stale staging files acquires only the `Update Lease`. The running CLIProxyAPI instance can be started, stopped, or restarted freely while downloads are underway.
2. **Atomic Commit Handover**: Once download, verification, and staging are complete, the update process briefly acquires the `Lifecycle Lease` to execute the atomic binary replacement and service restart.
3. **Async Reentrancy**: Leases support controlled in-process reentrancy within the same asynchronous task hierarchy via `AsyncLocalStorage`.
4. **Upgrade Ordering**: When executing `cpa upgrade`, MiniCPA acquires both the `Update Lease` and the `Lifecycle Lease` in fixed order to prevent replacing CLI modules while an active binary preparation is in flight.

---

## 4. Residual Risks

Kernel leases fail closed: if an endpoint cannot be created, the command refuses to run rather than proceeding without exclusion. They cannot deadlock or be stolen, but the endpoint name is predictable, so another program can keep it occupied:

- **macOS port collision**: The lease port is derived from a hash of the state directory (range `1024`–`65535`). If an unrelated application already listens on that `127.0.0.1` port, every `cpa` command reports `Cannot acquire MiniCPA lock lease (127.0.0.1:<port>)` until that application releases it. Any local user can bind loopback ports, so another account on the same Mac can also occupy it.
- **Windows named pipe squatting**: Named pipes live in a machine-wide namespace. Another local user who creates `\.\pipe\minicpa-<hash>` first blocks MiniCPA for the account whose state directory produced that hash.
- **Linux**: Abstract sockets are scoped to the network namespace. Processes in a different namespace (for example, a container sharing the home directory) do not see the same lease and are not excluded.

These are availability issues only: no path lets another process run commands as the user or bypass the lease. The error names the endpoint; identify its owner (`lsof -iTCP:<port>` on macOS, or Sysinternals `handle` / `pipelist` on Windows) and stop it.
