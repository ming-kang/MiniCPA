import { spawn } from "node:child_process";
import spawnCommand from "cross-spawn";
import fs from "node:fs";
import { renameWithWindowsRetry, syncDirectory } from "../fs-atomic.js";
import { activeExecutablePath, backupExecutablePath, ensureDir } from "../paths.js";
import { readInstallState, type InstallState } from "../state.js";
import { buildCredentialSafeChildEnv } from "./child-env.js";

/** Outcome of a finished child process: exit code plus its captured streams. */
export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
};

/** MiniCPA tokens are always stripped from the child environment (see AGENTS.md). */
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

/**
 * Probe the installed binary for its version by executing it.
 *
 * A running Windows image holds a section lock on its own file, so this must only
 * be called by a command that owns the MiniCPA lock. Unlocked read commands use
 * inspectRuntimeInstallation instead and report the last health-verified version
 * recorded by the update path.
 */
export async function readCurrentRuntimeVersion(home: string): Promise<string | undefined> {
  return readInstalledRuntimeVersion(activeExecutablePath(home));
}

/** A replacement owns its backup only after the old active file has been moved. */
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

  /** Copy/fsync before downtime. The caller owns staging cleanup in one finally. */
  prepare(source: string): void {
    ensureDir(this.home);
    stageBinary(source, this.staging);
  }

  /** Install an already prepared binary, retrying only the actual Windows renames. */
  install(): void {
    this.hadPrevious = fs.existsSync(this.target);
    if (this.hadPrevious) {
      // Failure here leaves the active version untouched and owns no backup.
      fs.rmSync(this.backup, { force: true });
      renameWithWindowsRetry(this.target, this.backup);
      this.phase = "backed-up";
    }
    renameWithWindowsRetry(this.staging, this.target);
    this.phase = "published";
    syncDirectory(this.home);
  }

  /** Never touches the active binary or any rollback/recovery file. */
  discard(): void {
    try {
      fs.rmSync(this.staging, { force: true });
    } catch {
      /* At most one deterministic staging residue; the next preparation replaces it. */
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

/** Atomically restore `.bak`, without needing free space for another binary copy. */
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

/** Drop backup after a successful update + restart. */
export function clearRuntimeBinaryBackup(home: string): void {
  const backup = backupExecutablePath(home);
  try {
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
  } catch {
    /* ignore */
  }
}

/** The active binary or its previous-version transaction backup. */
export type RunnableExecutableKind = "active" | "backup";

export type RunnableExecutableLocation = {
  /** The file that actually exists; only "active" is the canonical name. */
  path: string;
  kind: RunnableExecutableKind;
};

/** Read-only lookup. A backup contains the previous version, not the active one. */
export function inspectRunnableExecutable(home: string): RunnableExecutableLocation | undefined {
  const active = activeExecutablePath(home);
  if (fs.existsSync(active)) return { path: active, kind: "active" };
  const backup = backupExecutablePath(home);
  if (fs.existsSync(backup)) return { path: backup, kind: "backup" };
  return undefined;
}

export type RuntimeInstallationInspection = {
  executable?: RunnableExecutableLocation;
  /** Install metadata last written after a healthy update; reading never probes the executable. */
  state: InstallState;
};

/** Read-only installation view that never executes, repairs, or locks the binary. */
export function inspectRuntimeInstallation(home: string): RuntimeInstallationInspection {
  const executable = inspectRunnableExecutable(home);
  return {
    ...(executable ? { executable } : {}),
    state: readInstallState(home),
  };
}

/**
 * Path-only view of inspectRunnableExecutable for callers that only need to
 * know whether a runnable file exists. Prefer inspectRunnableExecutable when
 * the answer is reported to the user: the returned path may be the previous
 * `.bak` binary rather than the active one.
 */
export function findRunnableExecutable(home: string): string | undefined {
  return inspectRunnableExecutable(home)?.path;
}

/**
 * Run the managed binary attached to the current terminal.
 *
 * Takes the executable path from the caller rather than resolving it, so an
 * unlocked command (`cpa tui`) can pick it with inspectRunnableExecutable and
 * reach the same child process without repairing the instance home under a
 * concurrent, lock-holding `cpa update`.
 */
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

/** Locked resolver: restore an interrupted transaction's backup when the active binary is missing. */
export function resolveRunnableExecutable(home: string): string {
  const active = activeExecutablePath(home);
  if (fs.existsSync(active)) return active;
  // A crash between move-aside and rename can leave only `.bak`; use it.
  if (restoreRuntimeBinaryFromBackup(home) && fs.existsSync(active)) return active;
  throw new Error(`CLIProxyAPI binary not found under ${home}. Run: cpa update`);
}
