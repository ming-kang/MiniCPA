import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Recursive size of files under dir (symlinks ignored / best-effort). */
export function directorySizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      } catch {
        /* ignore races / permission */
      }
    }
  };
  walk(dir);
  return total;
}

/** One small event-log budget; permanent CPA output is handled by upstream rotation. */
export const MINICPA_LOG_ROTATE_BYTES = 1024 * 1024;

/** Matches exact semver versions (major.minor.patch[-prerelease][+build]) without ranges or prefixes. */
const EXACT_SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isExactSemver(version: string): boolean {
  return EXACT_SEMVER_REGEX.test(version);
}

/** Rotate to one generation, replacing .1 only when the rename succeeds. */
export function rotateFileIfLarge(file: string, options?: { maxBytes?: number }): boolean {
  const maxBytes = options?.maxBytes ?? MINICPA_LOG_ROTATE_BYTES;
  try {
    if (maxBytes < 1 || fs.statSync(file).size < maxBytes) return false;
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Append one already-single-line record to a private (0600) log file.
 *
 * Best-effort by contract: it creates the parent directory, rotates the file
 * once it outgrows `maxBytes`, and reports failure by returning false instead of
 * throwing. Callers write here to explain a failure they are already handling,
 * so a logging problem must never replace the error the user needs to see.
 *
 * `line` is appended verbatim plus one newline. Keeping it to a single line is
 * the caller's job: only the caller knows how to condense its own payload.
 */
export function appendPrivateLogLine(
  file: string,
  line: string,
  options?: { maxBytes?: number },
): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const maxBytes = options?.maxBytes ?? MINICPA_LOG_ROTATE_BYTES;
    const rotated = rotateFileIfLarge(file, { maxBytes });
    if (!rotated && fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
      // A blocked rename must not turn best-effort event logging into an
      // unlimited append-only file. Keep the old record and drop this one.
      return false;
    }
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeFileSync(fd, `${line}\n`);
    } finally {
      fs.closeSync(fd);
    }
    // The mode above only applies when the file is created, so an older log
    // keeps whatever mode it had; tighten it on every append.
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}

export function tailFile(file: string, maxLines = 40, maxBytes = 8 * 1024 * 1024): string {
  if (!fs.existsSync(file) || maxLines < 1 || maxBytes < 1) return "";
  const stat = fs.statSync(file);
  if (stat.size === 0) return "";

  const chunks: Buffer[] = [];
  let position = stat.size;
  let bytesRead = 0;
  let lineBreaks = 0;
  const fd = fs.openSync(file, "r");
  try {
    while (position > 0 && bytesRead < maxBytes && lineBreaks <= maxLines) {
      const length = Math.min(64 * 1024, position, maxBytes - bytesRead);
      position -= length;
      const chunk = Buffer.alloc(length);
      const n = fs.readSync(fd, chunk, 0, length, position);
      if (n === 0) break;
      const read = chunk.subarray(0, n);
      chunks.unshift(read);
      bytesRead += n;
      for (const byte of read) {
        if (byte === 0x0a) lineBreaks += 1;
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  // A newline-terminated file yields one trailing empty element; drop exactly
  // one so it does not consume a slot of the requested line budget.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-maxLines).join("\n").trimEnd();
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
