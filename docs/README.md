# MiniCPA Architecture & Design Reference

MiniCPA provides a lightweight, resilient, and non-opinionated process supervisor and binary manager for a single local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) instance.

This document serves as the high-level architecture overview and entry point to MiniCPA's system design documentation.

---

## Architecture Topology

```
                      +---------------------------------------+
                      |               MiniCPA                 |
                      |  - Process Supervisor                 |
                      |  - Binary Upgrader                    |
                      |  - Autostart Manager                  |
                      +-------------------+-------------------+
                                          |
                        Spawns & Monitors | (Detached Child)
                                          v
                      +---------------------------------------+
                      |             CLIProxyAPI               |
                      |  - Web UI / Management Panel          |
                      |  - Model Routing & Provider Auth      |
                      |  - Native Logging & Rotation          |
                      |  - Configuration (config.yaml)        |
                      +---------------------------------------+
```

---

## Architectural Principles

1. **Ownership Boundary**: MiniCPA provides an initial bootstrap `config.yaml` once upon first run. Subsequent configuration changes, credentials, provider tokens, and Web panel provisioning belong exclusively to CLIProxyAPI. MiniCPA treats configuration as opaque data and never parses, modifies, or synchronizes it.
2. **Kernel-Owned Concurrency**: Mutual exclusion is enforced by operating-system-level IPC endpoints rather than advisory filesystem lockfiles, eliminating deadlock and lock-stealing hazards.
3. **Non-Downtime Preparation**: Release discovery, streaming downloads, SHA-256 verification, and target-volume staging happen in an isolated workspace without service interruption. The lifecycle lease is acquired only during the brief atomic commit phase.
4. **Deterministic Identity Safety**: Daemon processes are tracked via numeric PIDs combined with platform-specific start markers, preventing catastrophic mis-signaling caused by OS PID recycling.
5. **Strict Boundary Isolation**: Child processes run in sanitized environments with sensitive API tokens stripped; local readiness probes and outbound asset downloads use isolated transport profiles.

---

## Architectural Topics

For deep-dive architectural specifications, refer to the individual topic guides:

- **[Concurrency & Dual-Lease Architecture](concurrency.md)**
  Kernel-owned IPC lease endpoints (Named Pipes, Abstract Sockets, Loopback listeners), dual-lease scope separation (Lifecycle vs. Update), and diagnostic metadata decoupling.

- **[Update Pipeline & Transaction Model](update-pipeline.md)**
  Two-phase updates (Phase 1 Preparation vs. Phase 2 Commit), target-volume pre-staging, atomic promotion, Windows transient sharing lock retry backoff, and automated `.bak` rollback.

- **[Process Lifecycle & Supervision](process-lifecycle.md)**
  Process fingerprinting (executable path + start-time marker), graceful stop escalation, native autostart topology (Windows VBS/Registry, Linux systemd user unit, macOS LaunchAgent), and log topology.

- **[Security & Boundary Isolation](security.md)**
  Child environment credential sanitization, private workspace storage, symlink attack defense, network dispatcher isolation, and archive decompression bomb prevention.
