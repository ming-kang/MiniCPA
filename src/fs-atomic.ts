import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PRIVATE_FILE_MODE = 0o600;

/** Flush a directory entry so a rename survives a power loss (no-op on win32). */
export function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* best-effort durability only */
  }
}

/** Backoff for the Windows replace retry; 5 attempts total. */
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400];
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/** writeFileAtomic is synchronous by contract, so the backoff must block. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Replace `to` with `from`, absorbing the transient Windows sharing violations
 * (EPERM/EBUSY/EACCES) that antivirus and indexers cause on a just-written file.
 * Retry the actual rename only; other platforms rename once. A failed replace
 * leaves the original in place and propagates to the caller.
 */
export function renameWithWindowsRetry(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (platform !== "win32" || delay === undefined || !code || !RETRYABLE_RENAME_CODES.has(code))
        throw err;
      sleepSync(delay);
    }
  }
}

/**
 * Write a private file via exclusive temp + atomic rename; never move the old file aside.
 * By default the parent directory is hardened to 0700; callers writing standard
 * OS directories can preserve an existing mode with `hardenDirectory: false`.
 */
export function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  options?: { mode?: number; hardenDirectory?: boolean },
): void {
  const directory = path.dirname(filePath);
  const mode = options?.mode ?? PRIVATE_FILE_MODE;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && options?.hardenDirectory !== false) {
    fs.chmodSync(directory, 0o700);
  }

  const base = path.basename(filePath);
  const temporaryPath = path.join(directory, `.${base}.${process.pid}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temporaryPath, "wx", mode);
  try {
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithWindowsRetry(temporaryPath, filePath);
    if (process.platform !== "win32") fs.chmodSync(filePath, mode);
    syncDirectory(directory);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}
