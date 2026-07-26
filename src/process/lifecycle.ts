import { spawn } from "node:child_process";
import fs from "node:fs";
import { activeExecutablePath, cpaLayout, ensureDir, hardenCpaPermissions } from "../paths.js";
import { clearPid, readPidRecord, writePidRecord } from "../state.js";
import { rotateFileIfLarge, sleep, tailFile } from "../util.js";
import { isProcessAlive } from "./alive.js";
import { buildCpaChildEnv } from "./child-env.js";
import { readinessUrls, waitForAnyHttpOk } from "./health.js";
import { classifyProcessIdentity, readProcessStartMarker } from "./pid-identity.js";
import { recoverUnlockProbeBinary, resolveRunnableExecutable } from "./runtime.js";

export { isProcessAlive } from "./alive.js";

const DEFAULT_READY_MS = 15_000;
const STOP_GRACE_MS = 5_000;
const STOP_KILL_WAIT_MS = 5_000;
/** Windows antivirus / explorer can hold the exe briefly after stop. */
export const FILE_UNLOCK_WAIT_MS = 30_000;

export type RunningInfo = {
  pid: number;
  exe: string;
  startedAt?: string;
  /** True when PID is alive but identity probe failed (kept for safety). */
  identityUnknown?: boolean;
};

export function resolveRunning(home: string): RunningInfo | undefined {
  const record = readPidRecord(home);
  if (!record) return undefined;

  if (!isProcessAlive(record.pid)) {
    clearPid(home);
    return undefined;
  }

  const currentStartMarker = readProcessStartMarker(record.pid);
  if (
    record.startMarker &&
    currentStartMarker &&
    record.startMarker !== currentStartMarker
  ) {
    clearPid(home);
    return undefined;
  }

  let exe: string;
  try {
    exe = resolveRunnableExecutable(home);
  } catch {
    exe = record.exe;
  }

  const identity = classifyProcessIdentity(record.pid, exe || record.exe);
  if (identity === "mismatch") {
    clearPid(home);
    return undefined;
  }

  return {
    pid: record.pid,
    exe: exe || record.exe,
    startedAt: record.startedAt || undefined,
    identityUnknown:
      identity === "unknown" ||
      (!!record.startMarker && !currentStartMarker),
  };
}

function openPrivateAppendLog(file: string): number {
  const fd = fs.openSync(file, "a", 0o600);
  try {
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    return fd;
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

function logPathsHint(home: string): string {
  const layout = cpaLayout(home);
  return `Check logs:\n  ${layout.logFile}\n  ${layout.errLogFile}`;
}

function dumpRecentLogs(home: string): string {
  const layout = cpaLayout(home);
  const parts: string[] = [];
  const err = tailFile(layout.errLogFile, 30);
  const out = tailFile(layout.logFile, 20);
  if (err) parts.push(`--- cpa.err.log (tail) ---\n${err}`);
  if (out) parts.push(`--- cpa.log (tail) ---\n${out}`);
  return parts.length ? `\n${parts.join("\n")}` : "";
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  const args = force
    ? ["/PID", String(pid), "/T", "/F"]
    : ["/PID", String(pid), "/T"];
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", args, {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("close", () => resolve());
    killer.on("error", () => resolve());
  });
}

/** Re-check immediately before a destructive signal to avoid PID-reuse kills. */
function assertSafeToStop(home: string, pid: number): void {
  const current = resolveRunning(home);
  if (!current || current.pid !== pid || current.identityUnknown) {
    throw new Error(
      `Refusing to stop PID=${pid}: MiniCPA can no longer verify it is the managed CPA process. ` +
        "Stop it manually if appropriate, then retry.",
    );
  }
}

/** Wait until the active binary is free for replace (Windows file locks). */
export async function waitForBinaryUnlocked(
  home: string,
  timeoutMs = FILE_UNLOCK_WAIT_MS,
): Promise<void> {
  recoverUnlockProbeBinary(home);
  const target = activeExecutablePath(home);
  if (!fs.existsSync(target)) return;
  const deadline = Date.now() + timeoutMs;
  let delay = 150;
  while (Date.now() < deadline) {
    recoverUnlockProbeBinary(home);
    const probe = `${target}.unlock-probe`;
    try {
      fs.renameSync(target, probe);
      try {
        fs.renameSync(probe, target);
        return;
      } catch (secondErr) {
        // Always try to put the binary back under the canonical name.
        try {
          if (fs.existsSync(probe) && !fs.existsSync(target)) {
            fs.renameSync(probe, target);
          }
        } catch {
          /* leave recovery to recoverUnlockProbeBinary */
        }
        throw secondErr;
      }
    } catch {
      await sleep(delay);
      delay = Math.min(1_000, Math.floor(delay * 1.5));
    }
  }
  recoverUnlockProbeBinary(home);
  throw new Error(
    `CPA binary still locked after ${timeoutMs}ms: ${target}. Close programs using it and retry.`,
  );
}

export type StartOptions = {
  /** Skip waiting for HTTP ready (default false). */
  noWait?: boolean;
  /** Max ms to wait for HTTP (default 15000). */
  readyTimeoutMs?: number;
};

export async function startDaemon(home: string, options?: StartOptions): Promise<RunningInfo> {
  recoverUnlockProbeBinary(home);

  const existing = resolveRunning(home);
  if (existing) {
    if (!options?.noWait) {
      const ready = await waitForAnyHttpOk(
        readinessUrls(home),
        options?.readyTimeoutMs ?? DEFAULT_READY_MS,
      );
      if (!ready) {
        throw new Error(
          `CPA PID=${existing.pid} is up but HTTP not reachable. Try: cpa restart${dumpRecentLogs(home)}\n${logPathsHint(home)}`,
        );
      }
    }
    return existing;
  }

  const layout = cpaLayout(home);
  ensureDir(layout.logsDir);
  ensureDir(layout.stateDir);
  ensureDir(layout.authsDir);
  ensureDir(layout.staticDir);
  hardenCpaPermissions(home);

  if (!fs.existsSync(layout.configFile)) {
    throw new Error(`Missing config: ${layout.configFile}. Run: cpa init`);
  }

  const exe = resolveRunnableExecutable(home);
  // Rotate oversized logs only when starting a new process (fd not yet held).
  rotateFileIfLarge(layout.logFile);
  rotateFileIfLarge(layout.errLogFile);
  const out = openPrivateAppendLog(layout.logFile);
  let err: number;
  try {
    err = openPrivateAppendLog(layout.errLogFile);
  } catch (error) {
    fs.closeSync(out);
    throw error;
  }

  const child = spawn(exe, ["-config", layout.configFile], {
    cwd: home,
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
    env: buildCpaChildEnv(),
  });
  let spawnError: Error | undefined;
  child.once("error", (err) => {
    spawnError = err;
  });

  child.unref();
  try {
    fs.closeSync(out);
    fs.closeSync(err);
  } catch {
    /* ignore */
  }

  if (!child.pid) {
    throw new Error("Failed to start CPA process");
  }

  const startedAt = new Date().toISOString();
  const startMarker = readProcessStartMarker(child.pid);
  writePidRecord(home, { pid: child.pid, exe, startedAt, startMarker });
  await sleep(500);

  if (spawnError) {
    clearPid(home);
    throw new Error(`Failed to start CPA: ${spawnError.message}`);
  }

  if (!isProcessAlive(child.pid)) {
    clearPid(home);
    throw new Error(`CPA exited immediately.${dumpRecentLogs(home)}\n${logPathsHint(home)}`);
  }

  if (!options?.noWait) {
    const readyMs = options?.readyTimeoutMs ?? DEFAULT_READY_MS;
    const ready = await waitForAnyHttpOk(readinessUrls(home), readyMs);
    if (!ready) {
      if (!isProcessAlive(child.pid)) {
        clearPid(home);
        throw new Error(`CPA exited before becoming ready.${dumpRecentLogs(home)}\n${logPathsHint(home)}`);
      }
      // Leave process running for diagnostics; do not clear PID.
      throw new Error(
        `CPA started (PID=${child.pid}) but HTTP not ready within ${readyMs}ms. Try: cpa restart${dumpRecentLogs(home)}\n${logPathsHint(home)}`,
      );
    }
  }

  return { pid: child.pid, exe, startedAt };
}

export async function stopDaemon(home: string): Promise<boolean> {
  const running = resolveRunning(home);
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

  if (process.platform === "win32") {
    assertSafeToStop(home, pid);
    await runTaskkill(pid, false);
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await sleep(200);
    }
    if (isProcessAlive(pid)) {
      assertSafeToStop(home, pid);
      await runTaskkill(pid, true);
      const hardDeadline = Date.now() + STOP_KILL_WAIT_MS;
      while (Date.now() < hardDeadline && isProcessAlive(pid)) {
        await sleep(100);
      }
    }
  } else {
    assertSafeToStop(home, pid);
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await sleep(200);
    }
    if (isProcessAlive(pid)) {
      assertSafeToStop(home, pid);
      try {
        process.kill(pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
      const hardDeadline = Date.now() + STOP_KILL_WAIT_MS;
      while (Date.now() < hardDeadline && isProcessAlive(pid)) {
        await sleep(100);
      }
    }
  }

  if (isProcessAlive(pid)) {
    throw new Error(
      `CPA PID=${pid} still running after stop. Not clearing PID file. Try: taskkill /PID ${pid} /F (Windows) or kill -9 ${pid}`,
    );
  }

  await waitForBinaryUnlocked(home);
  clearPid(home);
  return true;
}
