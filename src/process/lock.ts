import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, miniCpaRoot } from "../paths.js";
import { sleep } from "../util.js";
import { isProcessAlive } from "./alive.js";
import { probePidReuse, readProcessStartMarker } from "./pid-identity.js";

export type MiniCpaLockRecord = {
  pid: number;
  command: string;
  acquiredAt: string;
  startMarker?: string;
};

/** Per-process re-entrancy depth for the one global MiniCPA lock. */
const lockDepth = new Map<string, number>();

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
      const { reused } = probePidReuse(holder.pid, holder.startMarker);
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
 * preemptLock swallows unlink failures, so a transient Windows EBUSY strands the
 * aside copy forever. This only reports them: an automatic sweep would race a
 * concurrent preemptor's in-flight rename/restore.
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
  await tryAcquireLock(command);
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}
