# Process Lifecycle & Supervision

MiniCPA manages CLIProxyAPI as a detached background daemon, providing process tracking, PID-reuse prevention, graceful shutdown, and native operating-system autostart.

---

## 1. Process Fingerprinting & Identity Protection

A common pitfall in background daemon management is **PID recycling**: after a daemon terminates unexpectedly, the operating system kernel may reassign its numeric process ID (PID) to an unrelated application. A naive supervisor relying solely on PID liveness risks signaling or terminating the wrong process.

To guarantee process safety, MiniCPA pairs the recorded PID with platform-specific process fingerprinting:

```
                            +-------------------------+
                            |     Target PID Alive    |
                            +------------+------------+
                                         |
                                         v
                         +-------------------------------+
                         |   Process Verification Probe  |
                         +---------------+---------------+
                                         |
              +--------------------------+--------------------------+
              |                                                     |
              v                                                     v
    [ Executable Verification ]                            [ Start-Time Marker ]
    - Linux: /proc/<pid>/exe                               - Linux: /proc/<pid>/stat (ticks + boot_id)
    - Windows: WMI / Process Path                          - Windows: StartTime UTC Ticks
    - macOS: ps -o comm=                                   - macOS: ps -o lstart= (UTC-pinned instant)
```

### Safety Rules

- **Deterministic Identity**: A process is only confirmed as the managed daemon when both its executable image and its start marker match the recorded credentials.
- **Fail-Closed Guarantee**: If the process identity cannot be proven conclusively (for example, if the executable path is ambiguous or unreadable), MiniCPA **refuses destructive operations** (`stop`, force-kill, or clearing the PID record).

---

## 2. Graceful Termination Protocol

When terminating the managed daemon (`cpa stop` or during updates):

1. **Pre-Signal Verification**: MiniCPA validates process ownership immediately before issuing signals.
2. **Graceful Request**:
   - **POSIX (Linux / macOS)**: Sends `SIGTERM` and awaits process exit within a grace window.
   - **Windows**: Executes `taskkill /PID <pid> /T` without `/F` to allow graceful shutdown handlers to complete.
3. **Escalation to Force-Kill**:
   - If the process survives beyond the grace deadline, MiniCPA verifies identity once more before escalating to `SIGKILL` on POSIX or `taskkill /F` on Windows.
4. **Post-Mortem Cleanup**: The PID record is removed only after the process has definitively exited.

---

## 3. Platform Autostart Integration

MiniCPA provides native integration with each platform's login mechanisms (`cpa auto`):

| Operating System | Registration Mechanism | Implementation Details |
|------------------|------------------------|------------------------|
| **Windows** | HKCU Run / StartupApproved | Registers a hidden VBScript launcher (`wscript.exe minicpa-autostart.vbs`) under `%LOCALAPPDATA%\MiniCPA` |
| **Linux** | systemd user unit | Deploys `~/.config/systemd/user/minicpa.service` targeting `default.target`, recording `XDG_DATA_HOME` |
| **macOS** | user LaunchAgent | Deploys `~/Library/LaunchAgents/com.astralyn.minicpa.plist` loaded via `launchctl` |

### Headless Linux Linger Detection

On Linux systems, systemd user services normally run only while a user session is active. MiniCPA detects user linger status (`loginctl show-user --property=Linger`) and surfaces actionable guidance when persistent background startup without an active login is requested.

---

## 4. Observability & Log Topology

MiniCPA separates service application output from CLI supervisor diagnostics:

```
<home>/
  |-- logs/
  |     |-- main.log           <-- CLIProxyAPI native rotated application log
  |     +-- error-*.log        <-- CLIProxyAPI native request-error log files
  |
  +-- state/
        |-- cpa.pid            <-- Process tracking record (PID, exe, start marker)
        |-- cpa.lock           <-- Diagnostic lock metadata (PID, command, timestamp)
        +-- minicpa.log        <-- MiniCPA supervisor event log (startup results)
```

- **Native Logging**: CLIProxyAPI directly manages application file logging and continuous log rotation (`main.log` and `error-*.log`). MiniCPA streams these files via `cpa logs` without redirecting daemon standard output.
- **Log Directory**: CLIProxyAPI writes to `<home>/logs` only if that directory already exists; otherwise it silently falls back to `<auth-dir>/logs`. MiniCPA therefore creates that directory before every start — `<WRITABLE_PATH>/logs` when CLIProxyAPI's `WRITABLE_PATH` override is set, otherwise `<home>/logs` — so `cpa logs` and startup failure reports (which append the `main.log` tail) read the file CLIProxyAPI is actually writing.
- **Supervisor Events**: Startup outcomes (especially non-interactive login autostart failures) are recorded in `state/minicpa.log` outside CLIProxyAPI's log retention tree, ensuring the last failed start stays visible in `cpa status`. Every start attempt records one event — `cpa start`, `cpa restart`, and restarts during `cpa update` — so a later successful start supersedes an earlier failure. A command that could not acquire the lifecycle lock never attempted a start and records nothing.
