import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, miniCpaRoot } from "../paths.js";
import { sleep } from "../util.js";
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
/** A freshly created lock may still be between open("wx") and write. */
const EMPTY_LOCK_GRACE_MS = 2_000;

function resolveLockPath(): string {
  return path.join(miniCpaRoot(), "state", "cpa.lock");
}

function homeKey(): string {
  return path.resolve(resolveLockPath());
}

export type LockInspection =
  | { kind: "absent" }
  | { kind: "record"; record: MiniCpaLockRecord; raw: string }
  | { kind: "unreadable"; raw: string; mtimeMs?: number };

function parseLockRecord(raw: string): MiniCpaLockRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<MiniCpaLockRecord>;
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

function inspectLock(lockPath: string): LockInspection {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return { kind: "absent" };
  }
  const record = parseLockRecord(raw);
  if (record) return { kind: "record", record, raw };
  let mtimeMs: number | undefined;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    /* deleted while inspecting — treated as stale-unreadable below */
  }
  return { kind: "unreadable", raw, mtimeMs };
}

/**
 * Remove a lock we judged stale WITHOUT a blind unlink: rename it aside, confirm
 * the file still holds exactly the content the decision was based on, and only
 * then delete it. If the content changed, a new holder re-created the lock in
 * the meantime — put it back (or drop our copy if yet another lock appeared).
 *
 * Residual window: a displaced holder that verified before our rename could
 * briefly coexist with a new acquirer. The post-create verification in
 * tryAcquireLock plus this confirm-before-delete shrinks that window to the
 * microseconds between one read and one rename; a full fix needs OS-held file
 * locks, which have their own portability hazards (see AGENTS.md history).
 */
/** @internal exported for tests only */
export function preemptLock(lockPath: string, expected: LockInspection): boolean {
  if (expected.kind === "absent") return true;
  const aside = `${lockPath}.preempt.${process.pid}.${randomUUID()}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    // Raced with another preemptor or the holder released it.
    return false;
  }

  let observedRaw: string | undefined;
  try {
    observedRaw = fs.readFileSync(aside, "utf8");
  } catch {
    observedRaw = undefined;
  }

  if (observedRaw === expected.raw) {
    try {
      fs.unlinkSync(aside);
    } catch {
      /* ignore */
    }
    return true;
  }

  // Content changed since our decision: a live holder wrote it. Restore.
  try {
    fs.renameSync(aside, lockPath);
  } catch {
    // A newer lock already exists; drop our displaced copy.
    try {
      fs.unlinkSync(aside);
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Claim the global lock via exclusive create (`wx`). If the file already exists,
 * preempt only when the holder is provably gone (dead PID, PID reuse detected via
 * start marker, ourselves after a crashed finally, or stale corrupt content).
 */
async function tryAcquireLock(command: string): Promise<void> {
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
    if (attempt > 0) {
      await sleep(50 + Math.floor(Math.random() * 100));
    }

    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, payload);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      // Verify our record survived: a concurrent preemptor may have displaced it.
      const verified = inspectLock(lockPath);
      if (verified.kind !== "record" || verified.record.pid !== process.pid) {
        continue;
      }
      lockDepth.set(key, 1);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }

    const existing = inspectLock(lockPath);

    if (existing.kind === "absent") {
      continue;
    }

    if (existing.kind === "unreadable") {
      const age = existing.mtimeMs !== undefined ? Date.now() - existing.mtimeMs : Infinity;
      if (age < EMPTY_LOCK_GRACE_MS) {
        // Probably a concurrent acquirer between open("wx") and write — wait.
        continue;
      }
      preemptLock(lockPath, existing);
      continue;
    }

    const holder = existing.record;

    if (holder.pid === process.pid) {
      // Orphaned file from crashed finally — drop and retry exclusive create.
      preemptLock(lockPath, existing);
      continue;
    }

    if (isProcessAlive(holder.pid)) {
      const currentStartMarker = readProcessStartMarker(holder.pid);
      if (holder.startMarker && currentStartMarker && holder.startMarker !== currentStartMarker) {
        // PID reused by an unrelated process — the recorded holder is gone.
        preemptLock(lockPath, existing);
        continue;
      }
      throw new Error(
        `Another cpa ${holder.command} is running (PID=${holder.pid}). Retry after it finishes.`,
      );
    }

    preemptLock(lockPath, existing);
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
  const existing = inspectLock(lockPath);
  if (existing.kind !== "record" || existing.record.pid !== process.pid) return;
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
  await tryAcquireLock(command);
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}
