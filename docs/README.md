# MiniCPA Design Notes

These guides record what reading the code cannot tell you: why MiniCPA is designed the way it is, which alternatives were rejected, what risks remain, and which properties are deliberate contracts. They intentionally do not describe mechanisms, file layouts, or protocols — `src/` is the reference for those.

- **[Concurrency & lease design](concurrency.md)** — why mutual exclusion is kernel-owned rather than lockfile-based, why there are two lease scopes, and what availability risks remain.
- **[Update pipeline design](update-pipeline.md)** — why updates split into a non-downtime preparation phase and a brief atomic commit, and which invariants make rollback safe.
- **[Process identity & supervision](process-lifecycle.md)** — why a PID alone never identifies the managed daemon, and why destructive operations fail closed.
- **[Security & trust boundaries](security.md)** — the reasoning behind the isolation boundaries, and the trust decisions embedded in the bootstrap configuration.
