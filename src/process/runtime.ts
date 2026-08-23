import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncDirectory } from "../fs-atomic.js";
import {
  activeExecutablePath,
  backupExecutablePath,
  ensureDir,
  unlockProbePath,
} from "../paths.js";
import { buildCpaChildEnv } from "./child-env.js";

/** MiniCPA tokens are always stripped from the child environment (see AGENTS.md). */
export async function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const env = buildCpaChildEnv({ ...process.env, ...options?.env });
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
 *
 * This EXECUTES the managed binary, and a running Windows image holds a section
 * lock on its own file. Callers that run outside `withMiniCpaLock` (`cpa status`,
 * `cpa version`, `cpa doctor`) can therefore stall a concurrent `cpa update`
 * inside `waitForBinaryUnlocked` for the length of this probe.
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

/**
 * Replace the active CPA binary in-place, keeping a `.bak` for rollback.
 *
 * Deliberately does NOT record the installed version: install state is written
 * only after a healthy restart (see installBinaryPhase), so a failed update
 * never leaves state claiming a version that is not actually running.
 */
export function installRuntimeBinary(home: string, sourceExe: string): void {
  ensureDir(home);
  const target = activeExecutablePath(home);
  const backup = backupExecutablePath(home);
  const staging = `${target}.new`;

  fs.copyFileSync(sourceExe, staging);
  if (process.platform !== "win32") {
    fs.chmodSync(staging, 0o755);
  }
  // Flush the staged bytes before publishing them under the runnable name: a
  // power loss inside the writeback window would otherwise leave a truncated
  // executable that resolveRunnableExecutable happily hands back, and the `.bak`
  // that could have rescued it is dropped as soon as the update succeeds.
  const stagingFd = fs.openSync(staging, "r+");
  try {
    fs.fsyncSync(stagingFd);
  } finally {
    fs.closeSync(stagingFd);
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

  syncDirectory(path.dirname(target));
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
    env: buildCpaChildEnv(),
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
