import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, miniCpaRoot } from "../paths.js";
import { sleep } from "../util.js";
import { isProcessAlive } from "./alive.js";
import { acquireLockLease } from "./lock-lease.js";
import { probePidReuse, readProcessStartMarker } from "./pid-identity.js";

export type MiniCpaLockRecord = {
  pid: number;
  command: string;
  acquiredAt: string;
  startMarker?: string;
};

type LockOwner = { key: string; active: boolean };
const ownership = new AsyncLocalStorage<LockOwner>();

/** A freshly created lock may still be between open("wx") and write. */
const EMPTY_LOCK_GRACE_MS = 2_000;
/** Total acquisition budget, including the full empty-lock grace period. */
const ACQUIRE_TIMEOUT_MS = EMPTY_LOCK_GRACE_MS + 1_000;
const ACQUIRE_RETRY_MIN_MS = 50;
const ACQUIRE_RETRY_JITTER_MS = 100;

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
    if (typeof parsed.pid !== "number" || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0)
      return undefined;
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
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

/** Milliseconds since an ISO `acquiredAt`, or undefined when it is missing/unparseable. */
function lockAgeMs(acquiredAt: string | undefined): number | undefined {
  if (!acquiredAt) return undefined;
  const parsed = Date.parse(acquiredAt);
  if (!Number.isFinite(parsed)) return undefined;
  return Date.now() - parsed;
}

/** `, 12m ago` — appended to a holder timestamp only when that timestamp parses. */
function formatLockAgeSuffix(acquiredAt: string | undefined): string {
  const ageMs = lockAgeMs(acquiredAt);
  if (ageMs === undefined) return "";
  return `, ${Math.max(0, Math.round(ageMs / 60_000))}m ago`;
}

/** Remove stale metadata only while holding the kernel lease. Never displace a new record. */
export function preemptLock(lockPath: string, expected: LockInspection): boolean {
  if (expected.kind === "absent") return true;
  try {
    if (fs.readFileSync(lockPath, "utf8") !== expected.raw) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claim the global lock via exclusive create (`wx`). If the file already exists,
 * preempt only when the holder is provably gone (dead PID, PID reuse detected via
 * start marker, ourselves after a crashed finally, or stale corrupt content).
 */
async function tryAcquireLock(command: string, lockPath: string): Promise<void> {
  ensureDir(path.dirname(lockPath));
  const record: MiniCpaLockRecord = {
    pid: process.pid,
    command,
    acquiredAt: new Date().toISOString(),
    startMarker: await readProcessStartMarker(process.pid),
  };
  const payload = `${JSON.stringify(record)}\n`;

  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  let firstAttempt = true;

  while (firstAttempt || Date.now() < deadline) {
    if (!firstAttempt) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const delay = ACQUIRE_RETRY_MIN_MS + Math.floor(Math.random() * ACQUIRE_RETRY_JITTER_MS);
      await sleep(Math.min(delay, remaining));
    }
    firstAttempt = false;

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
        // Probably a concurrent acquirer between open("wx") and write. The
        // acquisition deadline includes this entire grace period, so keep
        // observing instead of exhausting an unrelated fixed attempt count.
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
      const { reused } = await probePidReuse(holder.pid, holder.startMarker);
      if (reused) {
        // PID reused by an unrelated process — the recorded holder is gone.
        preemptLock(lockPath, existing);
        continue;
      }
      // Deliberately fail closed: an unreadable marker on either side cannot
      // prove reuse, so tell the user exactly which file to remove instead of
      // guessing that the holder is gone.
      throw new Error(
        `Another cpa ${holder.command} is running (PID=${holder.pid}, held since ` +
          `${holder.acquiredAt || "unknown"}${formatLockAgeSuffix(holder.acquiredAt)}). ` +
          `Retry after it finishes.\nIf that process is gone, remove the lock file: ${lockPath}`,
      );
    }

    preemptLock(lockPath, existing);
  }

  throw new Error(`Failed to acquire MiniCPA lock within ${ACQUIRE_TIMEOUT_MS}ms. Retry.`);
}

function releaseLock(lockPath: string): void {
  const existing = inspectLock(lockPath);
  if (existing.kind !== "record" || existing.record.pid !== process.pid) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

export type MiniCpaLockStatus = {
  path: string;
  state: "absent" | "held" | "unreadable";
  pid?: number;
  command?: string;
  acquiredAt?: string;
  ageMs?: number;
  holderAlive?: boolean;
};

/**
 * Read-only view of the global lock for diagnostics (`cpa doctor`).
 *
 * Never writes, renames or unlinks anything, and never throws: a wedged lock is
 * exactly the situation where the user needs the report to still come out.
 */
export function inspectMiniCpaLock(): MiniCpaLockStatus {
  let lockPath = "";
  try {
    lockPath = resolveLockPath();
  } catch {
    return { path: lockPath, state: "unreadable" };
  }
  try {
    const existing = inspectLock(lockPath);
    if (existing.kind === "absent") return { path: lockPath, state: "absent" };
    if (existing.kind === "unreadable") return { path: lockPath, state: "unreadable" };
    const holder = existing.record;
    const ageMs = lockAgeMs(holder.acquiredAt);
    return {
      path: lockPath,
      state: "held",
      pid: holder.pid,
      command: holder.command,
      ...(holder.acquiredAt ? { acquiredAt: holder.acquiredAt } : {}),
      ...(ageMs !== undefined ? { ageMs } : {}),
      holderAlive: isProcessAlive(holder.pid),
    };
  } catch {
    return { path: lockPath, state: "unreadable" };
  }
}

/**
 * Absolute paths of leftover `cpa.lock.preempt.*` files beside the lock.
 *
 * Older versions renamed stale locks aside. Keep diagnosing their residue,
 * without racing a legacy process that may still be restoring one.
 */
export function listLockPreemptResidue(): string[] {
  try {
    const lockPath = resolveLockPath();
    const stateDir = path.dirname(lockPath);
    const prefix = `${path.basename(lockPath)}.preempt.`;
    return fs
      .readdirSync(stateDir)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => path.join(stateDir, entry));
  } catch {
    return [];
  }
}

/** Exclusive global lock for the one managed CPA instance. */
export async function withMiniCpaLock<T>(command: string, fn: () => Promise<T>): Promise<T> {
  const key = homeKey();
  const inherited = ownership.getStore();
  if (inherited?.active && inherited.key === key) return fn();
  ensureDir(path.dirname(key));
  let releaseLease: () => Promise<void>;
  try {
    releaseLease = await acquireLockLease(key);
  } catch (error) {
    const holder = inspectLock(key);
    if (holder.kind === "record") {
      throw new Error(
        `Another cpa ${holder.record.command} is running (PID=${holder.record.pid}). ` +
          `Retry after it finishes. Lock file: ${key}`,
        { cause: error },
      );
    }
    throw error;
  }
  const owner: LockOwner = { key, active: true };
  try {
    await tryAcquireLock(command, key);
    try {
      return await ownership.run(owner, fn);
    } finally {
      owner.active = false;
      releaseLock(key);
    }
  } finally {
    owner.active = false;
    await releaseLease();
  }
}
