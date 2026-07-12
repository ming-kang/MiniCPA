import { spawn } from "node:child_process";
import fs from "node:fs";
import { cpaLayout, ensureDir } from "../paths.js";
import { clearPid, readPid, writePid } from "../state.js";
import { sleep } from "../util.js";
import { resolveRunnableExecutable } from "./runtime.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type RunningInfo = {
  pid: number;
  exe: string;
};

export function resolveRunning(home: string): RunningInfo | undefined {
  const pid = readPid(home);
  if (pid && isProcessAlive(pid)) {
    return { pid, exe: resolveRunnableExecutable(home) };
  }
  if (pid) clearPid(home);

  return undefined;
}

export async function startDaemon(home: string): Promise<RunningInfo> {
  const existing = resolveRunning(home);
  if (existing) return existing;

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
  if (!child.pid) {
    throw new Error("Failed to start CPA process");
  }

  writePid(home, child.pid);
  await sleep(800);

  if (!isProcessAlive(child.pid)) {
    clearPid(home);
    throw new Error(
      `CPA exited immediately. Check logs:\n  ${layout.logFile}\n  ${layout.errLogFile}`,
    );
  }

  return { pid: child.pid, exe };
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
      await sleep(400);
      if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }

  clearPid(home);
  return true;
}