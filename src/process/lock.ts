import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, miniCpaRoot } from "../paths.js";
import { isProcessAlive } from "./alive.js";
import { acquireLockLease } from "./lock-lease.js";

export type MiniCpaLockRecord = {
  pid: number;
  command: string;
  acquiredAt: string;
};

type LockOwner = { key: string; active: boolean };
const ownership = new AsyncLocalStorage<readonly LockOwner[]>();

function resolveLockPath(scope: "lifecycle" | "update" = "lifecycle"): string {
  const state = path.join(miniCpaRoot(), "state");
  return scope === "update" ? path.join(state, "update", "cpa.lock") : path.join(state, "cpa.lock");
}

type LockInspection =
  | { kind: "absent" }
  | { kind: "record"; record: MiniCpaLockRecord }
  | { kind: "unreadable" };

function parseLockRecord(raw: string): MiniCpaLockRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<MiniCpaLockRecord>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.command !== "string" ||
      typeof parsed.acquiredAt !== "string"
    ) {
      return undefined;
    }
    return { pid: parsed.pid, command: parsed.command, acquiredAt: parsed.acquiredAt };
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
  return record ? { kind: "record", record } : { kind: "unreadable" };
}

function lockAgeMs(acquiredAt: string): number | undefined {
  const parsed = Date.parse(acquiredAt);
  return Number.isFinite(parsed) ? Date.now() - parsed : undefined;
}

export type MiniCpaLockStatus = { path: string } & (
  | { state: "absent" | "unreadable" }
  | {
      state: "record";
      pid: number;
      command: string;
      acquiredAt: string;
      ageMs?: number;
      holderAlive: boolean;
    }
);

/** Read diagnostic metadata only; a record does not prove the kernel lease is held. */
export function inspectMiniCpaLock(scope: "lifecycle" | "update" = "lifecycle"): MiniCpaLockStatus {
  const lockPath = resolveLockPath(scope);
  try {
    const existing = inspectLock(lockPath);
    if (existing.kind !== "record") return { path: lockPath, state: existing.kind };
    const record = existing.record;
    return {
      path: lockPath,
      state: "record",
      pid: record.pid,
      command: record.command,
      acquiredAt: record.acquiredAt,
      ageMs: lockAgeMs(record.acquiredAt),
      holderAlive: isProcessAlive(record.pid),
    };
  } catch {
    return { path: lockPath, state: "unreadable" };
  }
}

/** Exclusive lifecycle/commit lease for the one managed CPA instance. */
export function withMiniCpaLock<T>(command: string, fn: () => Promise<T>): Promise<T> {
  return withLock("lifecycle", command, fn);
}

/** Serialize update preparation and temp cleanup without blocking start/stop. */
export function withMiniCpaUpdateLock<T>(command: string, fn: () => Promise<T>): Promise<T> {
  return withLock("update", command, fn);
}

async function withLock<T>(
  scope: "lifecycle" | "update",
  command: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(resolveLockPath(scope));
  const inherited = ownership.getStore() ?? [];
  if (inherited.some((owner) => owner.active && owner.key === key)) return fn();
  ensureDir(path.dirname(key));
  let releaseLease: () => Promise<void>;
  try {
    releaseLease = await acquireLockLease(key, scope);
  } catch (error) {
    const holder = inspectMiniCpaLock(scope);
    if (holder.state === "record") {
      throw new Error(
        `Another cpa ${holder.command} is running (PID=${holder.pid}). ` +
          `Retry after it finishes. Lock record: ${key}`,
        { cause: error },
      );
    }
    throw error;
  }

  const owner: LockOwner = { key, active: true };
  try {
    const record: MiniCpaLockRecord = {
      pid: process.pid,
      command,
      acquiredAt: new Date().toISOString(),
    };
    fs.writeFileSync(key, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    try {
      return await ownership.run([...inherited, owner], fn);
    } finally {
      owner.active = false;
      fs.rmSync(key, { force: true });
    }
  } finally {
    owner.active = false;
    await releaseLease();
  }
}
