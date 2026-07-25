import fs from "node:fs";
import path from "node:path";
import { ensureDir, miniCpaRoot } from "../paths.js";
import { isProcessAlive } from "./alive.js";
import { readProcessStartMarker } from "./pid-identity.js";

export type MiniCpaLockRecord = {
  pid: number;
  command: string;
  acquiredAt: string;
  startMarker?: string;
};

/** Per-process re-entrancy depth for the one global MiniCPA lock. */
const lockDepth = new Map<string, number>();

const ACQUIRE_ATTEMPTS = 5;

function resolveLockPath(): string {
  return path.join(miniCpaRoot(), "state", "cpa.lock");
}

function homeKey(): string {
  return path.resolve(resolveLockPath());
}

function readLockRecord(lockPath: string): MiniCpaLockRecord | undefined {
  if (!fs.existsSync(lockPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<MiniCpaLockRecord>;
    if (typeof parsed.pid !== "number" || !Number.isFinite(parsed.pid)) return undefined;
    return {
      pid: parsed.pid,
      command: typeof parsed.command === "string" ? parsed.command : "unknown",
      acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
      startMarker: typeof parsed.startMarker === "string" ? parsed.startMarker : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Claim the global lock via exclusive create (`wx`). If the file already exists,
 * preempt only when the holder PID is dead (or is ourselves after a crashed finally).
 */
function tryAcquireLock(command: string): void {
  const key = homeKey();
  const depth = lockDepth.get(key) ?? 0;
  if (depth > 0) {
    lockDepth.set(key, depth + 1);
    return;
  }

  const lockPath = resolveLockPath();
  ensureDir(path.dirname(lockPath));
  const record: MiniCpaLockRecord = {
    pid: process.pid,
    command,
    acquiredAt: new Date().toISOString(),
    startMarker: readProcessStartMarker(process.pid),
  };
  const payload = JSON.stringify(record) + "\n";

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, payload);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      const verified = readLockRecord(lockPath);
      if (!verified || verified.pid !== process.pid) {
        throw new Error(
          `Failed to acquire MiniCPA lock (held by PID=${verified?.pid ?? "?"}). Retry.`,
        );
      }
      lockDepth.set(key, 1);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }

    const existing = readLockRecord(lockPath);
    if (!existing) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* raced with another acquirer */
      }
      continue;
    }

    if (existing.pid === process.pid) {
      // Orphaned file from crashed finally — drop and retry exclusive create.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* continue */
      }
      continue;
    }

    if (isProcessAlive(existing.pid)) {
      const currentStartMarker = readProcessStartMarker(existing.pid);
      if (
        existing.startMarker &&
        currentStartMarker &&
        existing.startMarker !== currentStartMarker
      ) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* raced with another preemptor */
        }
        continue;
      }
      throw new Error(
        `Another cpa ${existing.command} is running (PID=${existing.pid}). Retry after it finishes.`,
      );
    }

    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* raced with another preemptor */
    }
  }

  throw new Error(`Failed to acquire MiniCPA lock after ${ACQUIRE_ATTEMPTS} attempts. Retry.`);
}

function releaseLock(): void {
  const key = homeKey();
  const depth = lockDepth.get(key) ?? 0;
  if (depth > 1) {
    lockDepth.set(key, depth - 1);
    return;
  }
  if (depth === 1) {
    lockDepth.delete(key);
  }

  const lockPath = resolveLockPath();
  const existing = readLockRecord(lockPath);
  if (!existing || existing.pid !== process.pid) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

/** Exclusive global lock for the one managed CPA instance. */
export async function withMiniCpaLock<T>(
  command: string,
  fn: () => Promise<T>,
): Promise<T> {
  tryAcquireLock(command);
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}
