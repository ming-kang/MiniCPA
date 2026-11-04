import { spawn } from "node:child_process";
import fs from "node:fs";
import { recordMiniCpaEvent } from "../minicpa-log.js";
import { cpaLayout, ensureDir } from "../paths.js";
import {
  recentRuntimeLogs,
  runtimeLogDirectory,
  runtimeLogFile,
  runtimeLogSize,
} from "../runtime-logs.js";
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
  identityUnknown?: boolean;
};

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

  // Verified spawn-time start marker proves ownership even if exe probe is inconclusive.
  const markerDegraded = !!record.startMarker && !currentMarker;
  const identityUnknown = identity === "unknown" ? marker !== "same" : markerDegraded;

  return {
    pid: record.pid,
    exe,
    startedAt: record.startedAt || undefined,
    identityUnknown,
  };
}

export async function resolveRunning(home: string): Promise<RunningInfo | undefined> {
  return evaluateRunning(home, true);
}

export async function inspectRunning(home: string): Promise<RunningInfo | undefined> {
  return evaluateRunning(home, false);
}

/** A failed start whose message carries the main.log excerpt; `summary` is one line for the event log. */
export class StartFailure extends Error {
  readonly summary: string;

  constructor(home: string, headline: string, logsSince?: number) {
    const excerpt = recentRuntimeLogs(home, logsSince);
    super(
      [
        headline,
        ...(excerpt ? ["--- main.log ---", excerpt] : []),
        `Full log: ${runtimeLogFile(home)}`,
      ].join("\n"),
    );
    // The last line a dying CPA writes is usually its reason; drop the [time] [level] prefix.
    const lastLine = excerpt
      .split("\n")
      .at(-1)
      ?.replace(/^(\[[^\]]*\]\s*)+/, "");
    this.summary = lastLine ? `${headline} ${lastLine}` : headline;
  }
}

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

async function killUntrackedChild(pid: number): Promise<void> {
  try {
    await signalProcess(pid, true);
  } catch {
    /* best-effort cleanup */
  }
}

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
  noWait?: boolean;
  readyTimeoutMs?: number;
};

export type StartResult = RunningInfo & { alreadyRunning: boolean };

/**
 * Every start attempt — `cpa start`, `cpa restart`, and update restarts — leaves one
 * event so `cpa status` never reports a failure that a later start already superseded.
 */
export async function startDaemon(home: string, options?: StartOptions): Promise<StartResult> {
  try {
    const result = await launchDaemon(home, options);
    recordMiniCpaEvent(home, "info", `start ok pid=${result.pid}`);
    return result;
  } catch (err) {
    const reason =
      err instanceof StartFailure ? err.summary : err instanceof Error ? err.message : String(err);
    recordMiniCpaEvent(home, "error", `start failed: ${reason}`);
    throw err;
  }
}

async function launchDaemon(home: string, options?: StartOptions): Promise<StartResult> {
  const layout = cpaLayout(home);
  const urls = options?.noWait ? [] : readinessUrls();

  const existing = await resolveRunning(home);
  if (existing) {
    if (!options?.noWait) {
      const ready = await waitForAnyHttpOk(urls, options?.readyTimeoutMs ?? DEFAULT_READY_MS);
      if (!ready) {
        throw new StartFailure(
          home,
          `CLIProxyAPI is running (PID=${existing.pid}) but HTTP is not reachable. Try: cpa restart`,
        );
      }
    }
    return { ...existing, alreadyRunning: true };
  }

  ensureDir(layout.stateDir);
  // CPA writes to ./logs only if it already exists; otherwise it silently falls back to
  // <auth-dir>/logs, where neither `cpa logs` nor startup failure reports would look.
  ensureDir(runtimeLogDirectory(home));

  if (!fs.existsSync(layout.configFile)) {
    throw new Error(`Missing config: ${layout.configFile}. Run: cpa init`);
  }

  const exe = resolveRunnableExecutable(home);
  const logsSince = runtimeLogSize(home);
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
    // Terminate untracked child immediately so it cannot become a leaked daemon without a PID file.
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
    throw new StartFailure(home, "CLIProxyAPI exited immediately.", logsSince);
  }

  if (!options?.noWait) {
    const readyMs = options?.readyTimeoutMs ?? DEFAULT_READY_MS;
    const ready = await waitForAnyHttpOk(urls, readyMs);
    if (!ready) {
      if (!isProcessAlive(child.pid)) {
        clearPid(home);
        throw new StartFailure(home, "CLIProxyAPI exited before becoming ready.", logsSince);
      }
      throw new StartFailure(
        home,
        `CLIProxyAPI started (PID=${child.pid}) but was not ready within ${readyMs}ms. Try: cpa restart`,
        logsSince,
      );
    }
  }

  return { pid: child.pid, exe, startedAt, alreadyRunning: false };
}

export async function stopDaemon(home: string): Promise<boolean> {
  const running = await resolveRunning(home);
  if (!running) {
    clearPid(home);
    return false;
  }

  const pid = running.pid;
  // This snapshot is fresh; only the force signal, after the grace period, needs another.
  if (running.identityUnknown) {
    throw new Error(
      `Refusing to stop PID=${pid}: MiniCPA cannot verify process ownership. ` +
        "Stop it manually if appropriate, then retry.",
    );
  }

  if (await signalProcess(pid, false)) {
    await waitForProcessExit(pid, STOP_GRACE_MS, 200);
  }
  if (isProcessAlive(pid)) {
    await assertSafeToStop(home, pid);
    await signalProcess(pid, true);
    await waitForProcessExit(pid, STOP_KILL_WAIT_MS, 100);
  }

  if (isProcessAlive(pid)) {
    const forceStop =
      process.platform === "win32" ? `taskkill /PID ${pid} /T /F` : `kill -9 ${pid}`;
    throw new Error(
      `CLIProxyAPI is still running after stop (PID=${pid}). The PID file was kept. Try: ${forceStop}`,
    );
  }

  clearPid(home);
  return true;
}
