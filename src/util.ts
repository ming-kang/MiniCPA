import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildCpaChildEnv } from "./process/child-env.js";

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

/** Default CPA log rotate threshold (50 MiB). */
export const DEFAULT_LOG_ROTATE_BYTES = 50 * 1024 * 1024;

/** Keep this many rotated siblings (file.1 .. file.N). */
export const DEFAULT_LOG_ROTATE_KEEP = 2;

/**
 * If `file` is at least maxBytes, rotate to file.1 .. file.keep (drop oldest).
 * Returns true when a rotation happened.
 */
export function rotateFileIfLarge(
  file: string,
  options?: { maxBytes?: number; keep?: number },
): boolean {
  const maxBytes = options?.maxBytes ?? DEFAULT_LOG_ROTATE_BYTES;
  const keep = options?.keep ?? DEFAULT_LOG_ROTATE_KEEP;
  if (keep < 1 || maxBytes < 1) return false;
  if (!fs.existsSync(file)) return false;

  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;

  tryUnlink(`${file}.${keep}`);
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, to);
    } catch {
      tryUnlink(from);
    }
  }
  try {
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

export function tailFile(file: string, maxLines = 40): string {
  if (!fs.existsSync(file)) return "";
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  return lines.slice(-maxLines).join("\n").trimEnd();
}

export async function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    /** When true (default), strip MiniCPA tokens from the child environment. */
    scrubSecrets?: boolean;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const merged = { ...process.env, ...options?.env };
  const env = options?.scrubSecrets === false ? merged : buildCpaChildEnv(merged);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function tryUnlink(file: string): void {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

export function sha256File(file: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

export function parseCpaVersionFromHelp(text: string): string | undefined {
  const match = text.match(/CLIProxyAPI Version:\s*([^\s,]+)/i);
  return match?.[1];
}

export async function readInstalledRuntimeVersion(exePath: string): Promise<string | undefined> {
  if (!fs.existsSync(exePath)) return undefined;
  try {
    const result = await runCommand(exePath, ["--help"], { timeoutMs: 10_000 });
    const merged = `${result.stdout}\n${result.stderr}`;
    return parseCpaVersionFromHelp(merged);
  } catch {
    return undefined;
  }
}
