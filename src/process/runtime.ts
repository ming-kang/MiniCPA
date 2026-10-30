import { spawn } from "node:child_process";
import spawnCommand from "cross-spawn";
import fs from "node:fs";
import { renameWithWindowsRetry, syncDirectory } from "../fs-atomic.js";
import { activeExecutablePath, backupExecutablePath, ensureDir } from "../paths.js";
import { readInstallState, type InstallState } from "../state.js";
import { buildCredentialSafeChildEnv } from "./child-env.js";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
};

export async function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxOutputBytes?: number;
  },
): Promise<CommandResult> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const env = buildCredentialSafeChildEnv({ ...process.env, ...options?.env });
  return new Promise((resolve, reject) => {
    const child = spawnCommand(command, args, {
      cwd: options?.cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > (options?.maxOutputBytes ?? 1024 * 1024)) {
        fail(new Error(`Command output exceeds capture limit: ${command}`));
      } else chunks.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
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

// Windows locks running executables; reading current version by executing requires lifecycle lock.
export async function readCurrentRuntimeVersion(home: string): Promise<string | undefined> {
  return readInstalledRuntimeVersion(activeExecutablePath(home));
}

export class RuntimeBinaryTransaction {
  private phase: "prepared" | "backed-up" | "published" = "prepared";
  private hadPrevious: boolean;
  private readonly target: string;
  private readonly backup: string;
  private readonly staging: string;

  constructor(private readonly home: string) {
    this.target = activeExecutablePath(home);
    this.backup = backupExecutablePath(home);
    this.staging = `${this.target}.new`;
    this.hadPrevious = fs.existsSync(this.target);
  }

  prepare(source: string): void {
    ensureDir(this.home);
    stageBinary(source, this.staging);
  }

  install(): void {
    this.hadPrevious = fs.existsSync(this.target);
    if (this.hadPrevious) {
      fs.rmSync(this.backup, { force: true });
      renameWithWindowsRetry(this.target, this.backup);
      this.phase = "backed-up";
    }
    renameWithWindowsRetry(this.staging, this.target);
    this.phase = "published";
    syncDirectory(this.home);
  }

  discard(): void {
    try {
      fs.rmSync(this.staging, { force: true });
    } catch {
      /* best-effort */
    }
  }

  rollback(): { restored: boolean; previousAvailable: boolean } {
    if (this.phase === "prepared") {
      return { restored: false, previousAvailable: this.hadPrevious && fs.existsSync(this.target) };
    }
    if (this.hadPrevious) {
      const restored = restoreRuntimeBinaryFromBackup(this.home);
      return { restored, previousAvailable: restored };
    }
    try {
      fs.rmSync(this.target, { force: true });
    } catch {
      /* no usable previous version */
    }
    return { restored: false, previousAvailable: false };
  }

  commit(): void {
    clearRuntimeBinaryBackup(this.home);
  }
}

function stageBinary(source: string, staging: string): void {
  fs.copyFileSync(source, staging);
  if (process.platform !== "win32") fs.chmodSync(staging, 0o755);
  const fd = fs.openSync(staging, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function restoreRuntimeBinaryFromBackup(home: string): boolean {
  const target = activeExecutablePath(home);
  const backup = backupExecutablePath(home);
  if (!fs.existsSync(backup)) return false;

  try {
    if (process.platform !== "win32") fs.chmodSync(backup, 0o755);
    renameWithWindowsRetry(backup, target);
    syncDirectory(home);
    return true;
  } catch {
    return false;
  }
}

export function clearRuntimeBinaryBackup(home: string): void {
  const backup = backupExecutablePath(home);
  try {
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
  } catch {
    /* best-effort */
  }
}

export type RunnableExecutableKind = "active" | "backup";

export type RunnableExecutableLocation = {
  path: string;
  kind: RunnableExecutableKind;
};

export function inspectRunnableExecutable(home: string): RunnableExecutableLocation | undefined {
  const active = activeExecutablePath(home);
  if (fs.existsSync(active)) return { path: active, kind: "active" };
  const backup = backupExecutablePath(home);
  if (fs.existsSync(backup)) return { path: backup, kind: "backup" };
  return undefined;
}

export type RuntimeInstallationInspection = {
  executable?: RunnableExecutableLocation;
  state: InstallState;
};

export function inspectRuntimeInstallation(home: string): RuntimeInstallationInspection {
  const executable = inspectRunnableExecutable(home);
  return {
    ...(executable ? { executable } : {}),
    state: readInstallState(home),
  };
}

export function findRunnableExecutable(home: string): string | undefined {
  return inspectRunnableExecutable(home)?.path;
}

export async function runRuntimeAttached(
  exe: string,
  args: string[],
  options: { cwd: string; label: string },
): Promise<void> {
  const child = spawn(exe, args, {
    cwd: options.cwd,
    stdio: "inherit",
    env: buildCredentialSafeChildEnv(),
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${options.label} terminated by ${signal}`
            : `${options.label} exited with code ${code ?? 1}`,
        ),
      );
    });
  });
}

export function resolveRunnableExecutable(home: string): string {
  const active = activeExecutablePath(home);
  if (fs.existsSync(active)) return active;
  // Interrupted replace can leave only .bak; recover from it.
  if (restoreRuntimeBinaryFromBackup(home) && fs.existsSync(active)) return active;
  throw new Error(`CLIProxyAPI binary not found under ${home}. Run: cpa update`);
}
