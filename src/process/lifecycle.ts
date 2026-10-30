import { spawn } from "node:child_process";
import fs from "node:fs";
import { cpaLayout, ensureDir } from "../paths.js";
import { recentRuntimeLogs as dumpRecentLogs, runtimeLogFile } from "../runtime-logs.js";
import { clearPid, readPidRecord, writePidRecord } from "../state.js";
import { sleep } from "../util.js";
import { isProcessAlive } from "./alive.js";
import { buildCredentialSafeChildEnv } from "./child-env.js";
import { readinessUrls, waitForAnyHttpOk } from "./health.js";
import {
  inspectProcessIdentity,
  compareStartMarkers,
  readProcessStartMarker,
} from "./pid-identity.js";
import { findRunnableExecutable, resolveRunnableExecutable } from "./runtime.js";

const DEFAULT_READY_MS = 15_000;
const STOP_GRACE_MS = 5_000;
const STOP_KILL_WAIT_MS = 5_000;

export type RunningInfo = {
  pid: number;
  exe: string;
  startedAt?: string;
  /** True when PID is alive but identity probe failed (kept for safety). */
  identityUnknown?: boolean;
};

/**
 * Shared implementation behind resolveRunning and inspectRunning.
 *
 * With `repair` the instance home is healed as a side effect (stale pid records
 * are deleted and an interrupted transaction's `.bak` binary is restored);
 * without it nothing on disk is touched, so unlocked read-only commands cannot
 * race a lock-holding `cpa update` over the binary it is replacing.
 */
async function evaluateRunning(home: string, repair: boolean): Promise<RunningInfo | undefined> {
  const record = readPidRecord(home);
  if (!record) return undefined;

  if (!isProcessAlive(record.pid)) {
    if (repair) clearPid(home);
    return undefined;
  }

  let exe: string;
  if (repair) {
    try {
      exe = resolveRunnableExecutable(home);
    } catch {
      exe = record.exe;
    }
  } else {
    exe = findRunnableExecutable(home) ?? record.exe;
  }

  const { currentMarker, identity } = await inspectProcessIdentity(record.pid, exe);
  const marker = compareStartMarkers(record.startMarker, currentMarker);
  if (marker === "reused" || identity === "mismatch") {
    if (repair) clearPid(home);
    return undefined;
  }

  // A matching spawn-time start marker (boot id + start ticks, or matching tagged
  // Darwin instant) is PID-reuse-proof, so it alone verifies ownership when the
  // executable probe is inconclusive.
  // Incomparable markers (such as a legacy untagged Darwin marker vs. a tagged UTC
  // instant) cannot prove identity, so when the executable probe is unknown we fail
  // closed to prevent terminating an unverified PID.
  const markerDegraded = !!record.startMarker && !currentMarker;
  const identityUnknown = identity === "unknown" ? marker !== "same" : markerDegraded;

  return {
    pid: record.pid,
    exe,
    startedAt: record.startedAt || undefined,
    identityUnknown,
  };
}

/** Repairing lookup for commands that hold the MiniCPA lock. */
export async function resolveRunning(home: string): Promise<RunningInfo | undefined> {
  return evaluateRunning(home, true);
}

/** Read-only lookup for unlocked commands; never mutates the instance home. */
export async function inspectRunning(home: string): Promise<RunningInfo | undefined> {
  return evaluateRunning(home, false);
}

function logPathsHint(home: string): string {
  return `Check logs:\n  ${runtimeLogFile(home)}\n  ${cpaLayout(home).minicpaLogFile}`;
}

/** Resolves true when taskkill reported success (exit code 0). */
async function runTaskkill(pid: number, force: boolean): Promise<boolean> {
  const args = force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];
  return new Promise<boolean>((resolve) => {
    const killer = spawn("taskkill", args, {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("close", (code) => resolve(code === 0));
    killer.on("error", () => resolve(false));
  });
}

/** Send one platform-specific termination request; false means the graceful request failed. */
async function signalProcess(pid: number, force: boolean): Promise<boolean> {
  if (process.platform === "win32") return runTaskkill(pid, force);
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) await sleep(intervalMs);
}

/** Best-effort termination of a child MiniCPA can no longer keep track of. */
async function killUntrackedChild(pid: number): Promise<void> {
  try {
    await signalProcess(pid, true);
  } catch {
    /* the caller is already failing; report the original cause */
  }
}

/** Re-check immediately before a destructive signal to avoid PID-reuse kills. */
async function assertSafeToStop(home: string, pid: number): Promise<void> {
  const current = await resolveRunning(home);
  if (!current || current.pid !== pid || current.identityUnknown) {
    throw new Error(
      `Refusing to stop PID=${pid}: MiniCPA can no longer verify it is the managed CLIProxyAPI process. ` +
        "Stop it manually if appropriate, then retry.",
    );
  }
}

export type StartOptions = {
  /** Skip waiting for HTTP ready (default false). */
  noWait?: boolean;
  /** Max ms to wait for HTTP (default 15000). */
  readyTimeoutMs?: number;
};

export async function startDaemon(home: string, options?: StartOptions): Promise<RunningInfo> {
  const layout = cpaLayout(home);
  const urls = options?.noWait ? [] : readinessUrls();

  const existing = await resolveRunning(home);
  if (existing) {
    if (!options?.noWait) {
      const ready = await waitForAnyHttpOk(urls, options?.readyTimeoutMs ?? DEFAULT_READY_MS);
      if (!ready) {
        throw new Error(
          `CLIProxyAPI is running (PID=${existing.pid}) but HTTP is not reachable. Try: cpa restart${dumpRecentLogs(home)}\n${logPathsHint(home)}`,
        );
      }
    }
    return existing;
  }

  ensureDir(layout.stateDir);

  if (!fs.existsSync(layout.configFile)) {
    throw new Error(`Missing config: ${layout.configFile}. Run: cpa init`);
  }

  const exe = resolveRunnableExecutable(home);
  // CPA owns continuous log rotation. A detached child must not keep growing
  // another pair of stdout/stderr files after the MiniCPA command has exited.
  const child = spawn(exe, ["-config", layout.configFile], {
    cwd: home,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: buildCredentialSafeChildEnv(),
  });
  let spawnError: Error | undefined;
  child.once("error", (err) => {
    spawnError = err;
  });

  child.unref();

  if (!child.pid) {
    throw new Error("Failed to start the CLIProxyAPI process");
  }

  const startedAt = new Date().toISOString();
  const startMarker = await readProcessStartMarker(child.pid);
  try {
    writePidRecord(home, { pid: child.pid, exe, startedAt, startMarker });
  } catch (err) {
    // A live CPA with no PID record is invisible to `cpa status` and `cpa stop`,
    // and the next `cpa start` would launch a second instance that dies on the
    // port bind. Take the detached child down before surfacing the failure.
    await killUntrackedChild(child.pid);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `CLIProxyAPI started, but MiniCPA could not record its PID; the new process was terminated: ${reason}`,
      { cause: err },
    );
  }
  await sleep(500);

  if (spawnError) {
    clearPid(home);
    throw new Error(`Failed to start CLIProxyAPI: ${spawnError.message}`);
  }

  if (!isProcessAlive(child.pid)) {
    clearPid(home);
    throw new Error(
      `CLIProxyAPI exited immediately.${dumpRecentLogs(home)}\n${logPathsHint(home)}`,
    );
  }

  if (!options?.noWait) {
    const readyMs = options?.readyTimeoutMs ?? DEFAULT_READY_MS;
    const ready = await waitForAnyHttpOk(urls, readyMs);
    if (!ready) {
      if (!isProcessAlive(child.pid)) {
        clearPid(home);
        throw new Error(
          `CLIProxyAPI exited before becoming ready.${dumpRecentLogs(home)}\n${logPathsHint(home)}`,
        );
      }
      // Leave process running for diagnostics; do not clear PID.
      throw new Error(
        `CLIProxyAPI started (PID=${child.pid}) but was not ready within ${readyMs}ms. Try: cpa restart${dumpRecentLogs(home)}\n${logPathsHint(home)}`,
      );
    }
  }

  return { pid: child.pid, exe, startedAt };
}

export async function stopDaemon(home: string): Promise<boolean> {
  const running = await resolveRunning(home);
  if (!running) {
    clearPid(home);
    return false;
  }

  const pid = running.pid;
  if (running.identityUnknown) {
    throw new Error(
      `Refusing to stop PID=${pid}: MiniCPA cannot verify process ownership. ` +
        "Stop it manually if appropriate, then retry.",
    );
  }

  // Verify ownership immediately before sending any signal (graceful or force).
  await assertSafeToStop(home, pid);

  // A failed graceful taskkill cannot signal a windowless child; skip its grace wait.
  if (await signalProcess(pid, false)) {
    await waitForProcessExit(pid, STOP_GRACE_MS, 200);
  }
  if (isProcessAlive(pid)) {
    await assertSafeToStop(home, pid);
    await signalProcess(pid, true);
    await waitForProcessExit(pid, STOP_KILL_WAIT_MS, 100);
  }

  if (isProcessAlive(pid)) {
    throw new Error(
      `CLIProxyAPI is still running after stop (PID=${pid}). The PID file was kept. Try: taskkill /PID ${pid} /F (Windows) or kill -9 ${pid}`,
    );
  }

  // Stop finishes when the process is dead; updates handle their actual rename failures.
  clearPid(home);
  return true;
}
