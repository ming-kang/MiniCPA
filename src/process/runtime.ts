import { spawn } from "node:child_process";
import fs from "node:fs";
import { activeExecutablePath, backupExecutablePath, ensureDir } from "../paths.js";
import { buildCpaChildEnv } from "./child-env.js";

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

/**
 * Probe the installed binary for its version. Install state is only a record,
 * not proof that the binary still exists or is runnable.
 */
export async function readCurrentRuntimeVersion(home: string): Promise<string | undefined> {
  return readInstalledRuntimeVersion(activeExecutablePath(home));
}

function moveAsideExisting(target: string, backup: string): void {
  if (!fs.existsSync(target)) return;
  try {
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
  } catch {
    /* ignore */
  }
  try {
    fs.renameSync(target, backup);
  } catch {
    fs.copyFileSync(target, backup);
    try {
      fs.unlinkSync(target);
    } catch {
      /* Windows may still hold the file briefly */
    }
  }
}

/** Replace the active CPA binary in-place, keeping a `.bak` for rollback. */
export function installRuntimeBinary(home: string, _version: string, sourceExe: string): void {
  ensureDir(home);
  const target = activeExecutablePath(home);
  const backup = backupExecutablePath(home);
  const staging = `${target}.new`;

  fs.copyFileSync(sourceExe, staging);
  if (process.platform !== "win32") {
    fs.chmodSync(staging, 0o755);
  }

  moveAsideExisting(target, backup);

  try {
    fs.renameSync(staging, target);
  } catch {
    // Windows can refuse rename over existing; copy then drop staging.
    fs.copyFileSync(staging, target);
    try {
      fs.unlinkSync(staging);
    } catch {
      /* ignore */
    }
  }

  if (process.platform !== "win32") {
    fs.chmodSync(target, 0o755);
  }
}

/** Restore `.bak` over the active binary (best-effort). */
export function restoreRuntimeBinaryFromBackup(home: string): boolean {
  const target = activeExecutablePath(home);
  const backup = backupExecutablePath(home);
  if (!fs.existsSync(backup)) return false;

  try {
    if (fs.existsSync(target)) {
      try {
        fs.unlinkSync(target);
      } catch {
        /* continue with overwrite copy */
      }
    }
    fs.copyFileSync(backup, target);
    if (process.platform !== "win32") {
      fs.chmodSync(target, 0o755);
    }
    return true;
  } catch {
    return false;
  }
}

/** Drop backup after a successful update + restart. */
export function clearRuntimeBinaryBackup(home: string): void {
  const backup = backupExecutablePath(home);
  try {
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
  } catch {
    /* ignore */
  }
}

/** If a crash left the binary as `*.unlock-probe`, restore the canonical name. */
export function recoverUnlockProbeBinary(home: string): boolean {
  const active = activeExecutablePath(home);
  const probe = `${active}.unlock-probe`;
  if (fs.existsSync(active) || !fs.existsSync(probe)) return false;
  try {
    fs.renameSync(probe, active);
    return true;
  } catch {
    try {
      fs.copyFileSync(probe, active);
      try {
        fs.unlinkSync(probe);
      } catch {
        /* ignore */
      }
      return true;
    } catch {
      return false;
    }
  }
}

export function resolveRunnableExecutable(home: string): string {
  recoverUnlockProbeBinary(home);
  const active = activeExecutablePath(home);
  if (fs.existsSync(active)) return active;
  throw new Error(`CPA binary not found under ${home}. Run: cpa update`);
}
