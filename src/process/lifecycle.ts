import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { activeExecutablePath, cpaLayout, ensureDir } from "../paths.js";
import { clearPid, readPidRecord, writePidRecord } from "../state.js";
import { rotateFileIfLarge, sleep, tailFile } from "../util.js";
import { buildCpaChildEnv } from "./child-env.js";
import { managementUrl, waitForHttpOk } from "./health.js";
import { imageMatchesExpectedExe, parseTasklistImageName } from "./pid-identity.js";
import { resolveRunnableExecutable } from "./runtime.js";

const DEFAULT_READY_MS = 15_000;
const STOP_GRACE_MS = 5_000;
/** Windows antivirus / explorer can hold the exe briefly after stop. */
export const FILE_UNLOCK_WAIT_MS = 30_000;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Fail-closed: probe errors mean "not our process". */
export function processLooksLikeCpa(pid: number, expectedExe: string): boolean {
  const expected = expectedExe || "";
  if (!expected) return false;

  try {
    if (process.platform === "linux") {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      if (comm && imageMatchesExpectedExe(comm, expected)) return true;
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? "";
      if (!cmdline) return false;
      return imageMatchesExpectedExe(cmdline, expected);
    }

    if (process.platform === "win32") {
      const out = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", windowsHide: true, timeout: 3000 },
      ).trim();
      const image = parseTasklistImageName(out);
      if (!image) return false;
      return imageMatchesExpectedExe(image, expected);
    }

    if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      if (!out) return false;
      return imageMatchesExpectedExe(out, expected);
    }
  } catch {
    return false;
  }

  return false;
}

export type RunningInfo = {
  pid: number;
  exe: string;
  startedAt?: string;
};

export function resolveRunning(home: string): RunningInfo | undefined {
  const record = readPidRecord(home);
  if (!record) return undefined;

  if (!isProcessAlive(record.pid)) {
    clearPid(home);
    return undefined;
  }

  let exe: string;
  try {
    exe = resolveRunnableExecutable(home);
  } catch {
    exe = record.exe;
  }

  if (!processLooksLikeCpa(record.pid, exe || record.exe)) {
    clearPid(home);
    return undefined;
  }

  return { pid: record.pid, exe: exe || record.exe, startedAt: record.startedAt || undefined };
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

/** Wait until the active binary is free for replace (Windows file locks). */
export async function waitForBinaryUnlocked(
  home: string,
  timeoutMs = FILE_UNLOCK_WAIT_MS,
): Promise<void> {
  const target = activeExecutablePath(home);
  if (!fs.existsSync(target)) return;
  const deadline = Date.now() + timeoutMs;
  let delay = 150;
  while (Date.now() < deadline) {
    try {
      const probe = `${target}.unlock-probe`;
      fs.renameSync(target, probe);
      fs.renameSync(probe, target);
      return;
    } catch {
      await sleep(delay);
      delay = Math.min(1_000, Math.floor(delay * 1.5));
    }
  }
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
  const existing = resolveRunning(home);
  if (existing) {
    if (!options?.noWait) {
      const ready = await waitForHttpOk(managementUrl(home), options?.readyTimeoutMs ?? DEFAULT_READY_MS);
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

  if (!fs.existsSync(layout.configFile)) {
    throw new Error(`Missing config: ${layout.configFile}. Run: cpa init`);
  }

  const exe = resolveRunnableExecutable(home);
  // Rotate oversized logs only when starting a new process (fd not yet held).
  rotateFileIfLarge(layout.logFile);
  rotateFileIfLarge(layout.errLogFile);
  const out = fs.openSync(layout.logFile, "a");
  const err = fs.openSync(layout.errLogFile, "a");

  const child = spawn(exe, ["-config", layout.configFile], {
    cwd: home,
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
    env: buildCpaChildEnv(),
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
  writePidRecord(home, { pid: child.pid, exe, startedAt });
  await sleep(500);

  if (!isProcessAlive(child.pid)) {
    clearPid(home);
    throw new Error(`CPA exited immediately.${dumpRecentLogs(home)}\n${logPathsHint(home)}`);
  }

  if (!options?.noWait) {
    const readyMs = options?.readyTimeoutMs ?? DEFAULT_READY_MS;
    const ready = await waitForHttpOk(managementUrl(home), readyMs);
    if (!ready) {
      if (!isProcessAlive(child.pid)) {
        clearPid(home);
        throw new Error(`CPA exited before becoming ready.${dumpRecentLogs(home)}\n${logPathsHint(home)}`);
      }
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
  if (process.platform === "win32") {
    await runTaskkill(pid, false);
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await sleep(200);
    }
    if (isProcessAlive(pid)) {
      await runTaskkill(pid, true);
      const hardDeadline = Date.now() + 2_000;
      while (Date.now() < hardDeadline && isProcessAlive(pid)) {
        await sleep(100);
      }
    }
  } else {
    try {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + STOP_GRACE_MS;
      while (Date.now() < deadline && isProcessAlive(pid)) {
        await sleep(200);
      }
      if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }

  await waitForBinaryUnlocked(home);
  clearPid(home);
  return true;
}
