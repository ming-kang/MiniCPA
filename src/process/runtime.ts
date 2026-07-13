import fs from "node:fs";
import {
  activeExecutablePath,
  backupExecutablePath,
  ensureDir,
} from "../paths.js";
import { readInstallState, writeInstallState } from "../state.js";
import { readInstalledRuntimeVersion } from "../util.js";

/**
 * Prefer probing the on-disk binary; fall back to install state.
 * When probe and state disagree, probe wins (and state is refreshed).
 */
export async function readCurrentRuntimeVersion(home: string): Promise<string | undefined> {
  const state = readInstallState(home);
  const probed = await readInstalledRuntimeVersion(activeExecutablePath(home));
  if (probed) {
    if (state.runtimeVersion !== probed) {
      writeInstallState(home, {
        ...state,
        cpaHome: home,
        runtimeVersion: probed,
      });
    }
    return probed;
  }
  return state.runtimeVersion;
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

export function resolveRunnableExecutable(home: string): string {
  const active = activeExecutablePath(home);
  if (fs.existsSync(active)) return active;
  throw new Error(`CPA binary not found under ${home}. Run: cpa update`);
}
