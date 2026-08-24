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
 * Retrying is far cheaper than the rename-aside fallback, which briefly leaves
 * the target missing. Other platforms rename once and let the caller fall back.
 *
 * @internal exported for tests only
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

/** Deterministic sibling used by the Windows rename fallback (recoverable after a crash). */
export function replaceBackupPath(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.replace.bak`);
}

/**
 * A crash between "move original aside" and "move new file in" leaves only the
 * backup. Restore it so readers never lose the previous content silently.
 */
function recoverReplaceBackup(filePath: string, backupPath: string): void {
  try {
    if (!fs.existsSync(backupPath)) return;
    if (!fs.existsSync(filePath)) {
      fs.renameSync(backupPath, filePath);
      return;
    }
    // Both present: the replace completed; the backup is stale residue.
    fs.unlinkSync(backupPath);
  } catch {
    /* best-effort recovery; the write below may still succeed */
  }
}

/**
 * Write a private file via exclusive temp + rename.
 * By default the parent directory is hardened to 0700; callers writing standard
 * OS directories can preserve an existing mode with `hardenDirectory: false`.
 * If replacement is unsupported (notably on Windows), preserve the old file until
 * the new file is safely in place and restore it on failure.
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

  recoverReplaceBackup(filePath, replaceBackupPath(filePath));

  const base = path.basename(filePath);
  const temporaryPath = path.join(directory, `.${base}.${process.pid}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temporaryPath, "wx", mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore close failure during cleanup */
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
  fs.closeSync(fd);

  try {
    renameWithWindowsRetry(temporaryPath, filePath);
  } catch {
    const backupPath = replaceBackupPath(filePath);
    const hadOriginal = fs.existsSync(filePath);
    try {
      if (hadOriginal) fs.renameSync(filePath, backupPath);
      fs.renameSync(temporaryPath, filePath);
      if (hadOriginal) {
        try {
          fs.unlinkSync(backupPath);
        } catch {
          /* a recoverable backup residue is safer than failing a completed write */
        }
      }
    } catch (replacementError) {
      try {
        if (hadOriginal && fs.existsSync(backupPath) && !fs.existsSync(filePath)) {
          fs.renameSync(backupPath, filePath);
        }
      } catch {
        /* preserve the original failure below */
      }
      try {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      } catch {
        /* ignore cleanup failure */
      }
      throw replacementError;
    }
  }

  if (process.platform !== "win32") fs.chmodSync(filePath, mode);
  syncDirectory(directory);
}
