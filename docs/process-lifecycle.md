# Process Identity & Supervision Design

## Why a PID is never enough

Operating systems recycle PIDs. Once the managed daemon exits — especially unexpectedly — its numeric PID can be reassigned to an unrelated application within moments. A supervisor that trusts the PID alone will eventually signal, or kill, a process it does not own. For a tool whose whole job is starting and stopping a background service, that is the worst available failure mode: it damages something outside its own boundary.

MiniCPA therefore never treats the recorded PID as proof of identity. Destructive decisions require corroborating evidence that the process is the daemon MiniCPA spawned — the executable image behind the PID, plus a start marker captured at spawn time, compared against freshly probed values. The start marker is the stronger signal precisely because it is recorded at the one moment identity is certain: when MiniCPA itself creates the process.

## Fail-closed is a deliberate priority

When identity evidence is inconclusive — the executable path unreadable, a probe ambiguous, the markers incomparable — MiniCPA refuses to stop, force-kill, or clear the PID record, and asks the user to resolve the process manually. This trades operational convenience for a guarantee: the supervisor may occasionally decline to stop its own daemon, but it will never kill an innocent process. A stuck CLIProxyAPI is recoverable; a mis-signaled application is not.

The same priority shapes termination escalation. The graceful request goes out once, on a freshly verified identity; the forceful escalation after the grace window re-verifies first, because that window is exactly long enough for the original daemon to have exited and its PID to have been recycled into someone else's process.
