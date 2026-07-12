import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cpaLayout, ensureDir } from "../paths.js";
import { clearPid, readPidRecord, writePidRecord } from "../state.js";
import { sleep, tailFile } from "../util.js";
import { managementUrl, waitForHttpOk } from "./health.js";
import { resolveRunnableExecutable } from "./runtime.js";

const DEFAULT_READY_MS = 15_000;
const STOP_GRACE_MS = 5_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function basenameLower(p: string): string {
  return path.basename(p).toLowerCase();
}

/** Best-effort: does this PID look like our CPA binary? */
export function processLooksLikeCpa(pid: number, expectedExe: string): boolean {
  const expected = basenameLower(expectedExe).replace(/\.exe$/, "");
  if (!expected) return true;

  try {
    if (process.platform === "linux") {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim().toLowerCase();
      if (comm && (expected.startsWith(comm) || comm.startsWith(expected))) {
        return true;
      }
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? "";
      const base = basenameLower(cmdline).replace(/\.exe$/, "");
      return base.includes(expected) || base === expected;
    }

    if (process.platform === "win32") {
      // tasklist CSV: "image name","pid",...
      const out = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", windowsHide: true, timeout: 3000 },
      ).trim();
      if (!out || /^INFO:/i.test(out)) return false;
      // "cli-proxy-api.exe","1234",...
      const m = out.match(/^"([^"]+)"/);
      const image = (m?.[1] ?? out.split(",")[0] ?? "").replace(/^"|"$/g, "").toLowerCase();
      const imageBase = image.replace(/\.exe$/, "");
      return imageBase === expected || imageBase.includes(expected) || expected.includes(imageBase);
    }

    if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      if (!out) return false;
      const base = basenameLower(out).replace(/\.exe$/, "");
      return base === expected || base.includes(expected) || expected.includes(base);
    }
  } catch {
    // If the probe fails, keep the live PID rather than false-negative stop/status.
    return true;
  }

  return true;
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
  const out = fs.openSync(layout.logFile, "a");
  const err = fs.openSync(layout.errLogFile, "a");

  const child = spawn(exe, ["-config", layout.configFile], {
    cwd: home,
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
    env: process.env,
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
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("close", () => resolve());
      killer.on("error", () => resolve());
    });
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

  // Brief wait so file locks (Windows) release before in-place binary replace.
  await sleep(300);
  clearPid(home);
  return true;
}
