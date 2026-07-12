import fs from "node:fs";
import { activeExecutablePath, ensureDir } from "../paths.js";
import { readInstallState } from "../state.js";
import { readInstalledRuntimeVersion } from "../util.js";

/** Prefer install state; fall back to probing the binary. */
export async function readCurrentRuntimeVersion(home: string): Promise<string | undefined> {
  const state = readInstallState(home);
  if (state.runtimeVersion) return state.runtimeVersion;
  return readInstalledRuntimeVersion(activeExecutablePath(home));
}

/** Replace the active CPA binary in-place (single install, no version stack). */
export function installRuntimeBinary(home: string, _version: string, sourceExe: string): void {
  ensureDir(home);
  const target = activeExecutablePath(home);
  const staging = `${target}.new`;

  fs.copyFileSync(sourceExe, staging);
  if (process.platform !== "win32") {
    fs.chmodSync(staging, 0o755);
  }

  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
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

export function resolveRunnableExecutable(home: string): string {
  const active = activeExecutablePath(home);
  if (fs.existsSync(active)) return active;
  throw new Error(`CPA binary not found under ${home}. Run: cpa update`);
}
