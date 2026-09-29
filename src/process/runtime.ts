import { spawn } from "node:child_process";
import spawnCommand from "cross-spawn";
import fs from "node:fs";
import { renameWithWindowsRetry, syncDirectory } from "../fs-atomic.js";
import {
  activeExecutablePath,
  backupExecutablePath,
  ensureDir,
  unlockProbePath,
} from "../paths.js";
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
  private readonly hadPrevious: boolean;
  private readonly target: string;
  private readonly backup: string;

  constructor(private readonly home: string) {
    this.target = activeExecutablePath(home);
    this.backup = backupExecutablePath(home);
    this.hadPrevious = fs.existsSync(this.target);
  }

  install(source: string): void {
    ensureDir(this.home);
    const staging = `${this.target}.new`;
    try {
      stageBinary(source, staging);
      if (this.hadPrevious) {
        // Failure here leaves the active version untouched and owns no backup.
        fs.rmSync(this.backup, { force: true });
        renameWithWindowsRetry(this.target, this.backup);
        this.phase = "backed-up";
      }
      renameWithWindowsRetry(staging, this.target);
      this.phase = "published";
      syncDirectory(this.home);
    } finally {
      try {
        fs.rmSync(staging, { force: true });
      } catch {
        /* preserve install result */
      }
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

/** Replace the active binary; callers own rollback and recording the verified version. */
export function installRuntimeBinary(home: string, sourceExe: string): void {
  new RuntimeBinaryTransaction(home).install(sourceExe);
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

/** If a crash left the binary as `*.unlock-probe`, restore the canonical name. */
export function recoverUnlockProbeBinary(home: string): boolean {
  const active = activeExecutablePath(home);
  const probe = unlockProbePath(home);
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

/** Which name the managed binary was found under, in resolve precedence order. */
export type RunnableExecutableKind = "active" | "unlock-probe" | "backup";

export type RunnableExecutableLocation = {
  /** The file that actually exists; only "active" is the canonical name. */
  path: string;
  kind: RunnableExecutableKind;
};

/**
 * Read-only sibling of resolveRunnableExecutable for unlocked commands.
 *
 * Never renames, copies or unlinks anything, so `cpa status`, `cpa doctor` and
 * `cpa tui` cannot race a lock-holding `cpa update` over the binary it is
 * replacing.
 *
 * It reports every name the binary can legitimately be found under, because
 * "not under the canonical name" is not the same failure as "not on disk":
 * `unlock-probe` is the current binary left renamed by a crashed unlock probe
 * and `backup` is the previous version kept for rollback, and both are
 * recovered in place by the next `cpa start`. Only `undefined` means the user
 * has to re-download anything. Callers that display or execute `path` must
 * therefore handle all three kinds — a `backup` path holds the PREVIOUS
 * version's bytes.
 */
export function inspectRunnableExecutable(home: string): RunnableExecutableLocation | undefined {
  const active = activeExecutablePath(home);
  if (fs.existsSync(active)) return { path: active, kind: "active" };
  // Same precedence as resolveRunnableExecutable, which recovers the unlock
  // probe before it falls back to the backup.
  const probe = unlockProbePath(home);
  if (fs.existsSync(probe)) return { path: probe, kind: "unlock-probe" };
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
 * the answer is reported to the user: the returned path may be the `.bak` or
 * `.unlock-probe` residue rather than the active binary.
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

/** Mutating resolver: repairs crash residue, then returns the active binary. */
export function resolveRunnableExecutable(home: string): string {
  recoverUnlockProbeBinary(home);
  const active = activeExecutablePath(home);
  if (fs.existsSync(active)) return active;
  // A crash between move-aside and rename can leave only `.bak`; use it.
  if (restoreRuntimeBinaryFromBackup(home) && fs.existsSync(active)) return active;
  throw new Error(`CLIProxyAPI binary not found under ${home}. Run: cpa update`);
}
