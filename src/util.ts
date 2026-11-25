import crypto from "node:crypto";
import fs from "node:fs";

export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const EXACT_SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function isExactSemver(version: string): boolean {
  return EXACT_SEMVER_REGEX.test(version);
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
