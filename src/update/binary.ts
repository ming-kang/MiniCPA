import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import {
  ensureDir,
  executableName,
  miniCpaTempDownloadDir,
  miniCpaTempExtractDir,
} from "../paths.js";
import {
  resolveRunning,
  startDaemon,
  stopDaemon,
  waitForBinaryUnlocked,
} from "../process/lifecycle.js";
import {
  clearRuntimeBinaryBackup,
  installRuntimeBinary,
  readCurrentRuntimeVersion,
  restoreRuntimeBinaryFromBackup,
} from "../process/runtime.js";
import { readInstallState, writeInstallState } from "../state.js";
import { sha256File } from "../util.js";
import {
  downloadToFile,
  fetchChecksums,
  fetchCpaReleaseByTag,
  fetchLatestCpaRelease,
  listReleaseAssetCandidates,
  normalizeTagVersion,
  type GhRelease,
  type PickedReleaseAsset,
} from "./github.js";

export class BinaryUpdateError extends Error {
  readonly previousRestarted: boolean;
  readonly causeMessage: string;

  constructor(causeMessage: string, previousRestarted: boolean) {
    const suffix = previousRestarted
      ? "\nPrevious CPA was restarted after failed update."
      : "\nAlso failed to restart CPA. Run: cpa start";
    super(`${causeMessage}${suffix}`);
    this.name = "BinaryUpdateError";
    this.causeMessage = causeMessage;
    this.previousRestarted = previousRestarted;
  }
}

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
  const resolvedDirectory = path.resolve(directoryPath);
  const resolvedCandidate = path.resolve(candidatePath);
  const relative = path.relative(resolvedDirectory, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Find CPA executable under extract dir; reject path traversal. */
export function findSafeExtractedExecutable(destDir: string, exeName: string): string {
  const resolvedDest = fs.realpathSync(destDir);
  const candidates = fs
    .readdirSync(destDir, { recursive: true })
    .map((entry) => String(entry))
    .filter((relativePath) => path.basename(relativePath) === exeName)
    .map((relativePath) => path.join(destDir, relativePath));

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    let realCandidate: string;
    try {
      realCandidate = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    if (!isPathInsideDirectory(realCandidate, resolvedDest)) {
      throw new Error(`Refusing extracted path outside staging: ${candidate}`);
    }
    return realCandidate;
  }
  throw new Error(`${exeName} not found in extract directory`);
}

function isUnsafeArchiveEntryName(entryName: string): boolean {
  const normalized = entryName.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return true;
  const parts = normalized.split("/");
  return parts.some((p) => p === "..");
}

async function extractArchive(archivePath: string, destDir: string): Promise<string> {
  const exeName = executableName();
  fs.mkdirSync(destDir, { recursive: true });

  if (archivePath.endsWith(".zip")) {
    const zip = new AdmZip(archivePath);
    const entry = zip
      .getEntries()
      .find((e) => !e.isDirectory && path.basename(e.entryName) === exeName);
    if (!entry) throw new Error(`${exeName} not found in ${archivePath}`);
    if (isUnsafeArchiveEntryName(entry.entryName)) {
      throw new Error(`Unsafe zip entry path: ${entry.entryName}`);
    }
    const out = path.join(destDir, exeName);
    fs.writeFileSync(out, entry.getData());
    return out;
  }

  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    await tar.x({
      file: archivePath,
      cwd: destDir,
      // Only extract the expected executable (and parent dirs implicitly).
      filter: (entryPath, entry) => {
        if (isUnsafeArchiveEntryName(entryPath)) return false;
        const type = (entry as { type?: string }).type;
        if (type === "SymbolicLink" || type === "Link") return false;
        const base = path.posix.basename(entryPath.replace(/\\/g, "/"));
        // Allow directories so nested layouts extract parents; tar may still need them.
        if (type === "Directory" || entryPath.endsWith("/")) return true;
        return base === exeName;
      },
    });
    return findSafeExtractedExecutable(destDir, exeName);
  }

  throw new Error(`Unsupported archive: ${archivePath}`);
}

/**
 * Verify the downloaded release archive against checksums.txt.
 * CLIProxyAPI publishes SHA-256 of the zip/tar.gz asset names, not the nested binary.
 */
export function verifyArchiveChecksum(
  checksums: Map<string, string>,
  archivePath: string,
  archiveName: string,
  options?: { insecure?: boolean },
): void {
  if (options?.insecure) return;
  if (checksums.size === 0) {
    throw new Error("No checksums available (use --insecure to skip integrity check)");
  }
  const keys = [archiveName, path.basename(archivePath)];
  const expected = keys.map((key) => checksums.get(key)).find(Boolean);
  if (!expected) {
    throw new Error(
      `No checksum entry for archive ${archiveName} (tried: ${keys.join(", ")}). Use --insecure to skip.`,
    );
  }
  const actual = sha256File(archivePath);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${archiveName}`);
  }
}

export type BinaryUpdateResult = {
  version: string;
  changed: boolean;
  skipped: boolean;
  /** True if process was stopped for the update and started again. */
  restarted: boolean;
};

export async function checkBinaryUpdate(home: string): Promise<{
  current?: string;
  latest: string;
  upToDate: boolean;
}> {
  const current = await readCurrentRuntimeVersion(home);
  const release = await fetchLatestCpaRelease();
  const latest = normalizeTagVersion(release.tag_name);
  return {
    current,
    latest,
    upToDate: !!current && current === latest,
  };
}

async function downloadFirstAvailableAsset(
  candidates: PickedReleaseAsset[],
  downloadDir: string,
): Promise<{ picked: PickedReleaseAsset; archivePath: string }> {
  if (candidates.length === 0) {
    throw new Error("No release asset candidates for this platform");
  }
  let lastError: Error | undefined;
  for (const picked of candidates) {
    const archivePath = path.join(downloadDir, picked.assetName);
    try {
      await downloadToFile(picked.url, archivePath, { label: picked.assetName });
      return { picked, archivePath };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!/Download failed 404/i.test(lastError.message)) {
        throw lastError;
      }
      try {
        fs.unlinkSync(archivePath);
      } catch {
        /* ignore */
      }
    }
  }
  throw lastError ?? new Error("All release asset candidates failed to download");
}

/**
 * Replace CPA binary in place.
 * - Download + checksum + extract happen **before** stopping a running CPA.
 * - Running process is stopped only for the brief install window, then restarted.
 * - Already-latest installs are skipped unless `force` or a specific `version` is requested.
 * - `.bak` is cleared only after a successful install (and healthy restart when it was running).
 * - On any phase-2 failure, restore `.bak` when present; if it was running, stop → restore → start.
 */
export async function updateBinary(
  home: string,
  options?: { version?: string; force?: boolean; insecure?: boolean },
): Promise<BinaryUpdateResult> {
  const wasRunning = !!resolveRunning(home);
  const currentVersion = await readCurrentRuntimeVersion(home);

  const release: GhRelease = options?.version
    ? await fetchCpaReleaseByTag(options.version)
    : await fetchLatestCpaRelease();

  const version = normalizeTagVersion(release.tag_name);
  const alreadyLatest = !options?.version && !!currentVersion && currentVersion === version;

  if (alreadyLatest && !options?.force) {
    return { version, changed: false, skipped: true, restarted: false };
  }

  const candidates = listReleaseAssetCandidates(release, process.platform, process.arch);
  const downloadDir = miniCpaTempDownloadDir("binary-");
  const staging = miniCpaTempExtractDir();

  try {
    const { picked, archivePath } = await downloadFirstAvailableAsset(candidates, downloadDir);
    const assetName = picked.assetName;

    if (!options?.insecure) {
      const checksums = await fetchChecksums(release);
      verifyArchiveChecksum(checksums, archivePath, assetName);
    } else {
      console.error("Warning: --insecure skips archive integrity verification");
    }

    const extractedExe = await extractArchive(archivePath, staging);

    // Phase 2: brief downtime for in-place replace.
    if (wasRunning) {
      console.log("Stopping CPA for binary replace…");
      await stopDaemon(home);
    }

    try {
      await waitForBinaryUnlocked(home);
      installRuntimeBinary(home, version, extractedExe);

      let restarted = false;
      if (wasRunning) {
        console.log("Restarting CPA…");
        // startDaemon waits for HTTP ready by default.
        await startDaemon(home);
        restarted = true;
      }

      // Only record the new version after a healthy install (+ restart when needed).
      const next = readInstallState(home);
      writeInstallState(home, {
        ...next,
        cpaHome: home,
        runtimeVersion: version,
        lastUpdateCheck: new Date().toISOString(),
      });

      clearRuntimeBinaryBackup(home);
      return { version, changed: true, skipped: false, restarted };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("Update failed; restoring previous binary…");

      // Half-started new process may still be running after a failed restart.
      if (resolveRunning(home)) {
        try {
          await stopDaemon(home);
        } catch {
          /* best-effort */
        }
      }

      restoreRuntimeBinaryFromBackup(home);

      const next = readInstallState(home);
      writeInstallState(home, {
        ...next,
        cpaHome: home,
        runtimeVersion: currentVersion,
        lastUpdateCheck: new Date().toISOString(),
      });

      if (wasRunning) {
        try {
          await startDaemon(home);
          throw new BinaryUpdateError(msg, true);
        } catch (restartErr) {
          if (restartErr instanceof BinaryUpdateError) throw restartErr;
          const restartMessage =
            restartErr instanceof Error ? restartErr.message : String(restartErr);
          throw new BinaryUpdateError(`${msg}\nRestart error: ${restartMessage}`, false);
        }
      }

      throw err;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}
