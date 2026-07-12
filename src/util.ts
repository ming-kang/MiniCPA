import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
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
  const result = await runCommand(exePath, ["--help"]);
  const merged = `${result.stdout}\n${result.stderr}`;
  return parseCpaVersionFromHelp(merged);
}