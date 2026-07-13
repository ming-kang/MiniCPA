import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fs-atomic.js";
import { cpaLayout, ensureDir } from "../paths.js";

export type HomeLockRecord = {
  pid: number;
  command: string;
  acquiredAt: string;
};

/** Per-process re-entrancy depth keyed by resolved home. */
const lockDepthByHome = new Map<string, number>();

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveLockPath(home: string): string {
  return path.join(cpaLayout(home).stateDir, "cpa.lock");
}

function homeKey(home: string): string {
  return path.resolve(home);
}

function readLockRecord(lockPath: string): HomeLockRecord | undefined {
  if (!fs.existsSync(lockPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<HomeLockRecord>;
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid)) return undefined;
    return {
      pid: parsed.pid,
      command: typeof parsed.command === "string" ? parsed.command : "unknown",
      acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
    };
  } catch {
    return undefined;
  }
}

function tryAcquireLock(home: string, command: string): void {
  const key = homeKey(home);
  const depth = lockDepthByHome.get(key) ?? 0;
  if (depth > 0) {
    lockDepthByHome.set(key, depth + 1);
    return;
  }

  const layout = cpaLayout(home);
  ensureDir(layout.stateDir);
  const lockPath = resolveLockPath(home);
  const existing = readLockRecord(lockPath);
  if (existing) {
    if (existing.pid === process.pid) {
      // Orphaned file from crashed finally — take ownership
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* continue */
      }
    } else if (isProcessAlive(existing.pid)) {
      throw new Error(
        `Another cpa ${existing.command} is running (PID=${existing.pid}). Retry after it finishes.`,
      );
    } else {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* race — continue to claim */
      }
    }
  }

  const record: HomeLockRecord = {
    pid: process.pid,
    command,
    acquiredAt: new Date().toISOString(),
  };
  writeFileAtomic(lockPath, JSON.stringify(record) + "\n");

  const verified = readLockRecord(lockPath);
  if (!verified || verified.pid !== process.pid) {
    throw new Error(
      `Failed to acquire CPA_HOME lock (held by PID=${verified?.pid ?? "?"}). Retry.`,
    );
  }
  lockDepthByHome.set(key, 1);
}

function releaseLock(home: string): void {
  const key = homeKey(home);
  const depth = lockDepthByHome.get(key) ?? 0;
  if (depth > 1) {
    lockDepthByHome.set(key, depth - 1);
    return;
  }
  if (depth === 1) {
    lockDepthByHome.delete(key);
  }

  const lockPath = resolveLockPath(home);
  const existing = readLockRecord(lockPath);
  if (!existing) return;
  if (existing.pid !== process.pid) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

/** Exclusive CPA_HOME lock for start/stop/update (stale holder auto-preempted). */
export async function withHomeLock<T>(
  home: string,
  command: string,
  fn: () => Promise<T>,
): Promise<T> {
  tryAcquireLock(home, command);
  try {
    return await fn();
  } finally {
    releaseLock(home);
  }
}
