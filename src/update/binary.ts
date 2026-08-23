import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import {
  activeExecutablePath,
  executableName,
  miniCpaTempDownloadDir,
  miniCpaTempExtractDir,
} from "../paths.js";
import {
  resolveRunning,
  startDaemon,
  stopDaemon,
  waitForBinaryUnlocked,
  type RunningInfo,
  type StartOptions,
} from "../process/lifecycle.js";
import {
  clearRuntimeBinaryBackup,
  installRuntimeBinary,
  readCurrentRuntimeVersion,
  restoreRuntimeBinaryFromBackup,
} from "../process/runtime.js";
import { patchInstallState } from "../state.js";
import { removeDirBestEffort, sha256File } from "../util.js";
import {
  CPA_REPO,
  cpaAssetNameCandidates,
  cpaReleaseAssetNames,
  fetchCpaReleaseByTag,
  listReleaseAssetCandidates,
  type PickedReleaseAsset,
} from "./cpa-release.js";
import {
  downloadToFile,
  fetchChecksums,
  fetchLatestRelease,
  normalizeTagVersion,
  type GhRelease,
} from "./github-client.js";
import { silentUpdateReporter, type UpdateReporter } from "./reporter.js";

const MAX_BINARY_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_EXECUTABLE_BYTES = 512 * 1024 * 1024;

export class BinaryUpdateError extends Error {
  readonly previousRestarted: boolean;
  readonly previousRestored: boolean;
  readonly causeMessage: string;

  constructor(
    causeMessage: string,
    previousRestarted: boolean,
    recovery?: { previousRestored?: boolean; previousAvailable?: boolean },
  ) {
    const previousRestored = recovery?.previousRestored === true;
    let suffix: string;
    if (previousRestarted) {
      suffix = previousRestored
        ? "\nThe previous CLIProxyAPI version was restored and restarted."
        : "\nThe existing CLIProxyAPI version was restarted.";
    } else if (recovery?.previousAvailable === false) {
      suffix = "\nNo previous CLIProxyAPI executable could be restored. Run: cpa update";
    } else {
      suffix = previousRestored
        ? "\nThe previous CLIProxyAPI version was restored but could not be restarted. Run: cpa start"
        : "\nThe existing CLIProxyAPI version could not be restarted. Run: cpa start";
    }
    super(`${causeMessage}${suffix}`);
    this.name = "BinaryUpdateError";
    this.causeMessage = causeMessage;
    this.previousRestarted = previousRestarted;
    this.previousRestored = previousRestored;
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

export function isUnsafeArchiveEntryName(entryName: string): boolean {
  const normalized = entryName.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return true;
  const parts = normalized.split("/");
  return parts.some((p) => p === "..");
}

export async function extractArchive(
  archivePath: string,
  destDir: string,
  options?: { maxExtractedBytes?: number },
): Promise<string> {
  const exeName = executableName();
  const maxExtractedBytes = options?.maxExtractedBytes ?? MAX_EXTRACTED_EXECUTABLE_BYTES;
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
    if (entry.header.size > maxExtractedBytes) {
      throw new Error(`${exeName} in ${archivePath} exceeds extraction size limit`);
    }
    const data = entry.getData();
    // The declared header size is attacker-controlled; re-check the inflated bytes.
    if (data.length > maxExtractedBytes) {
      throw new Error(
        `${exeName} in ${archivePath} exceeds extraction size limit ` +
          `(declared ${entry.header.size}, actual ${data.length})`,
      );
    }
    const out = path.join(destDir, exeName);
    fs.writeFileSync(out, data);
    return out;
  }

  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    // A throw inside the tar filter escapes as an uncaught stream error, so
    // record violations and fail after extraction finishes instead.
    let oversizedEntry: string | undefined;
    await tar.x({
      file: archivePath,
      cwd: destDir,
      // Only extract the expected executable (and parent dirs implicitly).
      filter: (entryPath, entry) => {
        if (isUnsafeArchiveEntryName(entryPath)) return false;
        const type = (entry as { type?: string }).type;
        if (type === "SymbolicLink" || type === "Link") return false;
        const base = path.posix.basename(entryPath.replace(/\\/g, "/"));
        const size = (entry as { size?: number }).size;
        if (typeof size === "number" && size > maxExtractedBytes) {
          oversizedEntry = entryPath;
          return false;
        }
        // Allow directories so nested layouts extract parents; tar may still need them.
        if (type === "Directory" || entryPath.endsWith("/")) return true;
        return base === exeName;
      },
    });
    if (oversizedEntry) {
      throw new Error(`${exeName} in ${archivePath} exceeds extraction size limit`);
    }
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
): void {
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
  skipped: boolean;
  /** Recorded CLIProxyAPI version before this operation, when known. */
  previousVersion?: string;
  /** True if process was stopped for the update and started again. */
  restarted: boolean;
};

export async function checkBinaryUpdate(home: string): Promise<{
  current?: string;
  latest: string;
  upToDate: boolean;
}> {
  const current = await readCurrentRuntimeVersion(home);
  const release = await fetchLatestRelease(CPA_REPO, cpaReleaseAssetNames);
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
  reporter: UpdateReporter,
): Promise<{ picked: PickedReleaseAsset; archivePath: string }> {
  if (candidates.length === 0) {
    throw new Error("No release asset candidates for this platform");
  }
  let lastError: Error | undefined;
  for (const picked of candidates) {
    const archivePath = path.join(downloadDir, picked.assetName);
    try {
      await downloadToFile(picked.url, archivePath, {
        label: picked.assetName,
        maxBytes: MAX_BINARY_ARCHIVE_BYTES,
        onProgress: (event) => reporter.progress?.(event),
      });
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

/** Process-lifecycle seam so update phase-2 failures can be tested with fakes. */
export type BinaryUpdateDeps = {
  stopDaemon(home: string): Promise<boolean>;
  startDaemon(home: string, options?: StartOptions): Promise<RunningInfo>;
  resolveRunning(home: string): RunningInfo | undefined;
  waitForBinaryUnlocked(home: string): Promise<void>;
};

export const defaultBinaryUpdateDeps: BinaryUpdateDeps = {
  stopDaemon,
  startDaemon,
  resolveRunning,
  waitForBinaryUnlocked,
};

/**
 * Phase 2 of a binary update: brief downtime for the in-place replace.
 * stop → wait for file unlock → install → restart → record state → clear `.bak`.
 * On failure: stop any half-started process, restore `.bak`, rewrite state, restart.
 */
export async function installBinaryPhase(
  home: string,
  args: {
    version: string;
    extractedExe: string;
    wasRunning: boolean;
    currentVersion?: string;
  },
  deps: BinaryUpdateDeps = defaultBinaryUpdateDeps,
  reporter: UpdateReporter = silentUpdateReporter,
): Promise<{ restarted: boolean }> {
  const { version, extractedExe, wasRunning, currentVersion } = args;

  if (wasRunning) {
    reporter.info("Stopping CLIProxyAPI to install the update…");
    await deps.stopDaemon(home);
  }

  // Whether there was anything to roll back to at all. A fresh install has no
  // previous binary, so a leftover file under the active name after a failure is
  // the half-installed NEW one and must not be reported as a usable rollback.
  const hadPreviousBinary = fs.existsSync(activeExecutablePath(home));

  try {
    await deps.waitForBinaryUnlocked(home);
    installRuntimeBinary(home, extractedExe);

    let restarted = false;
    if (wasRunning) {
      reporter.info("Restarting CLIProxyAPI…");
      // startDaemon waits for HTTP ready by default.
      await deps.startDaemon(home);
      restarted = true;
    }

    // Only record the new version after a healthy install (+ restart when needed).
    patchInstallState(home, {
      runtimeVersion: version,
      lastUpdateCheck: new Date().toISOString(),
    });

    clearRuntimeBinaryBackup(home);
    return { restarted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reporter.warn("CLIProxyAPI update failed; recovering the previous installation…");

    // Half-started new process may still be running after a failed restart.
    if (deps.resolveRunning(home)) {
      try {
        await deps.stopDaemon(home);
      } catch {
        /* best-effort */
      }
    }

    const restored = restoreRuntimeBinaryFromBackup(home);
    // `.bak` presence is not the same question as "is a usable previous binary on
    // disk?". Every failure raised before installRuntimeBinary moves the old binary
    // aside — a file lock that keeps waitForBinaryUnlocked from returning, but also
    // an ENOSPC/EACCES on its staging copy, chmod or fsync — leaves the previous
    // binary byte-intact under the active name and creates no `.bak` at all. Ask
    // the filesystem, gated on there having been a previous binary in the first
    // place so a half-installed fresh install is still reported as unrecoverable.
    const binaryPresent =
      restored || (hadPreviousBinary && fs.existsSync(activeExecutablePath(home)));

    // Never record a version when no binary is on disk to back it.
    patchInstallState(home, {
      runtimeVersion: binaryPresent ? currentVersion : undefined,
      lastUpdateCheck: new Date().toISOString(),
    });

    if (wasRunning) {
      if (!binaryPresent) {
        throw new BinaryUpdateError(msg, false, { previousAvailable: false });
      }
      try {
        await deps.startDaemon(home);
        throw new BinaryUpdateError(msg, true, { previousRestored: restored });
      } catch (restartErr) {
        if (restartErr instanceof BinaryUpdateError) throw restartErr;
        const restartMessage =
          restartErr instanceof Error ? restartErr.message : String(restartErr);
        throw new BinaryUpdateError(`${msg}\nRestart error: ${restartMessage}`, false, {
          previousRestored: restored,
        });
      }
    }

    throw err;
  }
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
  options?: {
    version?: string;
    force?: boolean;
    insecure?: boolean;
    reporter?: UpdateReporter;
    deps?: BinaryUpdateDeps;
  },
): Promise<BinaryUpdateResult> {
  const reporter = options?.reporter ?? silentUpdateReporter;
  const deps = options?.deps ?? defaultBinaryUpdateDeps;
  const wasRunning = !!deps.resolveRunning(home);
  const currentVersion = await readCurrentRuntimeVersion(home);

  const release: GhRelease = options?.version
    ? await fetchCpaReleaseByTag(options.version)
    : await fetchLatestRelease(CPA_REPO, cpaReleaseAssetNames);

  const version = normalizeTagVersion(release.tag_name);
  const alreadyLatest = !options?.version && !!currentVersion && currentVersion === version;

  if (alreadyLatest && !options?.force) {
    return { version, previousVersion: currentVersion, skipped: true, restarted: false };
  }

  const candidates = listReleaseAssetCandidates(release, process.platform, process.arch);
  if (candidates.length === 0) {
    throw new Error(
      `No release asset for ${process.platform}/${process.arch}. Tried: ${cpaAssetNameCandidates(
        release.tag_name,
        process.platform,
        process.arch,
      ).join(", ")}`,
    );
  }
  const downloadDir = miniCpaTempDownloadDir("binary-");
  const staging = miniCpaTempExtractDir();

  try {
    const { picked, archivePath } = await downloadFirstAvailableAsset(
      candidates,
      downloadDir,
      reporter,
    );
    const assetName = picked.assetName;

    if (!options?.insecure) {
      const checksums = await fetchChecksums(release, CPA_REPO);
      verifyArchiveChecksum(checksums, archivePath, assetName);
    } else {
      reporter.warn("Warning: --insecure skips archive integrity verification");
    }

    const extractedExe = await extractArchive(archivePath, staging);

    const { restarted } = await installBinaryPhase(
      home,
      { version, extractedExe, wasRunning, currentVersion },
      deps,
      reporter,
    );
    return { version, previousVersion: currentVersion, skipped: false, restarted };
  } finally {
    // Never let temp cleanup turn a completed update into a reported failure.
    removeDirBestEffort(staging, (message) => reporter.warn(message));
    removeDirBestEffort(downloadDir, (message) => reporter.warn(message));
  }
}
