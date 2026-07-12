import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function tailFile(file: string, maxLines = 40): string {
  if (!fs.existsSync(file)) return "";
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  return lines.slice(-maxLines).join("\n").trimEnd();
}

export async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
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
