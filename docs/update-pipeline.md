# Update Pipeline Design

## Why two phases

Replacing the binary of a running service hits hazards no platform escapes:

- **Downtime must not scale with network speed.** Stopping the daemon before downloading turns every slow transfer into service outage.
- **Windows locks running executables.** Replacement is impossible while the daemon runs — yet stopping early is exactly what lengthens the outage.
- **Antivirus engines and indexers transiently lock freshly written files**, so even a correct replacement can fail spuriously within the first few hundred milliseconds.
- **A corrupted or partial download must never reach the installation.**

The design answer is a strict phase split. **Preparation** — release discovery, download, integrity verification, extraction, and staging of the new executable — runs entirely while the service keeps running, holding only the update lease. **Commit** — stop, swap, restart — compresses everything that requires the lifecycle lease into the shortest possible window.

## Contracts the implementation upholds

These properties are deliberate design commitments; a refactor that breaks any of them is a regression, however plausible the code looks:

- **Verification precedes service impact.** Checksum and extraction failures can only abort the update, never damage the installation, because nothing in preparation touches the active binary or the daemon.
- **Commit is renames-only.** The new binary is staged and fsynced next to the active one during preparation, so the commit window contains no cross-filesystem copies — only atomic same-volume renames. This is what keeps the restart window short, and what makes absorbing transient Windows sharing violations with retry backoff sufficient.
- **Rollback is transaction-local.** If the replacement fails to start, only the backup produced moments earlier by the same transaction may be restored; a stale backup from an older update must never overwrite the active installation.
- **Interruption converges.** A crash or power loss mid-swap leaves enough state beside the target for later commands to restore a runnable installation instead of requiring manual repair.
