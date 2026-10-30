# Update Pipeline & Transaction Model

MiniCPA structures binary updates as a two-phase transaction to ensure zero-downtime staging, atomic replacement, and automated rollback upon failure.

---

## 1. Architectural Overview

Updating a running binary across different operating systems presents several hazards:
- **Service downtime during download**: Traditional update scripts stop the daemon before downloading, causing extended service downtime during slow network transfers.
- **In-use file locking**: On Windows, the operating system kernel prevents replacing an executable that is currently running (section locking).
- **Transient antivirus locks**: Security software and desktop indexers frequently hold temporary read locks on newly written executables immediately after staging.
- **Incomplete or corrupted downloads**: Network failures or corrupted archives must never leave the installation in a broken state.

MiniCPA resolves these challenges through a strict separation between **Preparation** and **Commit**.

---

## 2. Two-Phase Update Workflow

```
+---------------------------------------------------------------------------------------+
| Phase 1: Preparation (Non-Downtime)                                                   |
|   Holds: Update Lease | Service: Continues Running                                    |
|                                                                                       |
|   1. Discover release tag & current-target asset (browser path with API fallback)      |
|   2. Stream download archive to isolated temporary operation directory                |
|   3. Verify archive SHA-256 against upstream checksums                                |
|   4. Extract executable safely with size, depth, and traversal bounds                  |
|   5. Stage binary to target filesystem (<active>.new) and execute fsync               |
+---------------------------------------------------------------------------------------+
                                           |
                                           v
+---------------------------------------------------------------------------------------+
| Phase 2: Commit (Atomic Transition)                                                   |
|   Holds: Lifecycle Lease (+ Update Lease) | Service: Brief Restart Window             |
|                                                                                       |
|   1. Verify current running state and acquire Lifecycle Lease                         |
|   2. Gracefully stop CLIProxyAPI daemon (if running)                                  |
|   3. Move active executable to backup: <active> -> <active>.bak                        |
|   4. Promote staged executable: <active>.new -> <active>                              |
|   5. Restart CLIProxyAPI daemon (if previously running)                               |
|   6. Commit install metadata (<home>/state/install.json)                              |
+---------------------------------------------------------------------------------------+
                                           |
                              +------------+------------+
                              |                         |
                           Success                   Failure
                              |                         |
                              v                         v
                       Purge .bak               Automated Rollback
                                           (<active>.bak -> <active> & Restart)
```

---

## 3. Preparation Details

- **Target-Volume Pre-Staging**: The new binary is copied to the final target volume (`<home>/cli-proxy-api.new`) and synchronized to disk (`fsync`) during Phase 1. This guarantees that Phase 2 only performs filesystem-local atomic renames rather than cross-volume copies during downtime.
- **Isolated Staging Workspaces**: Each update operation uses a private, uniquely named staging directory under `<root>/temp/operations/update-<uuid>` to prevent concurrent or orphaned update collisions.

---

## 4. Resilience & Automated Rollback

- **Windows Transient Lock Backoff**: When renaming files on Windows, transient file-sharing violations (`EPERM`, `EBUSY`, `EACCES`) caused by indexers or antivirus engines are automatically absorbed using exponential retry backoff.
- **Fail-Safe Rollback Protocol**:
  - If the new executable fails to start or exits prematurely during post-replacement verification, MiniCPA automatically rolls back the previous executable from `<active>.bak` and restarts it.
  - Rollback always uses the exact backup produced by that transaction; stale backups from earlier updates cannot overwrite an active installation.
- **Crash Recovery**: If an unexpected power outage occurs between moving the old binary aside and promoting the new binary, subsequent locked lifecycle commands detect the intact `.bak` and automatically restore it.
