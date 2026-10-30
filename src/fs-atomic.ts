import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PRIVATE_FILE_MODE = 0o600;

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
    /* best-effort */
  }
}

const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400];
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// Retry transient Windows sharing violations (antivirus/indexers) during in-place replace.
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
