import path from "node:path";
import { HttpStatusError } from "../http.js";
import { miniCpaTempOperationDir } from "../paths.js";
import { withMiniCpaLock, withMiniCpaUpdateLock } from "../process/lock.js";
import {
  inspectRuntimeInstallation,
  readCurrentRuntimeVersion,
  RuntimeBinaryTransaction,
} from "../process/runtime.js";
import {
  cleanupPreviousUpdateOperations,
  cleanupTempFiles,
  removeTempOperation,
} from "../temp-files.js";
import { sha256File } from "../util.js";
import { extractArchive } from "./archive.js";
import {
  defaultBinaryUpdateDeps,
  installBinaryPhase,
  type BinaryUpdateDeps,
} from "./binary-install.js";
import { fetchChecksums } from "./checksum.js";
import {
  CPA_REPO,
  cpaAssetNameCandidates,
  fetchCpaReleaseByTag,
  resolveCpaRelease,
  type CpaReleaseAsset,
} from "./cpa-release.js";
import { downloadToFile } from "./download.js";
import { fetchLatestRelease, normalizeTagVersion } from "./github-client.js";
import { silentUpdateReporter, type UpdateReporter } from "./reporter.js";

export {
  extractArchive,
  findSafeExtractedExecutable,
  isUnsafeArchiveEntryName,
} from "./archive.js";
export { installBinaryPhase, type BinaryUpdateDeps } from "./binary-install.js";
export { BinaryUpdateError } from "./binary-error.js";

const MAX_BINARY_ARCHIVE_BYTES = 512 * 1024 * 1024;

/** Verify the release archive against upstream checksums.txt; no new integrity scheme. */
export async function verifyArchiveChecksum(
  checksums: Map<string, string>,
  archivePath: string,
  archiveName: string,
): Promise<void> {
  if (checksums.size === 0)
    throw new Error("No checksums available (use --insecure to skip integrity check)");
  const keys = [archiveName, path.basename(archivePath)];
  const expected = keys.map((key) => checksums.get(key)).find(Boolean);
  if (!expected) {
    throw new Error(
      `No checksum entry for archive ${archiveName} (tried: ${keys.join(", ")}). Use --insecure to skip.`,
    );
  }
  if ((await sha256File(archivePath)) !== expected)
    throw new Error(`Checksum mismatch for ${archiveName}`);
}

export type BinaryUpdateResult = {
  version: string;
  skipped: boolean;
  previousVersion?: string;
  restarted: boolean;
};

export type BinaryCheckDeps = { fetchLatestRelease: typeof fetchLatestRelease };

export async function checkBinaryUpdate(
  home: string,
  deps: BinaryCheckDeps = { fetchLatestRelease },
): Promise<{ current?: string; latest: string; upToDate: boolean }> {
  const current = recordedVersion(home);
  const release = await deps.fetchLatestRelease(CPA_REPO);
  const latest = normalizeTagVersion(release.tag);
  return { current, latest, upToDate: !!current && current === latest };
}

function recordedVersion(home: string): string | undefined {
  const installed = inspectRuntimeInstallation(home);
  return installed.executable?.kind === "active" ? installed.state.runtimeVersion : undefined;
}

/** Network/filesystem preparation seams keep update concurrency tests offline. */
export type BinaryPrepareDeps = {
  fetchLatestRelease: typeof fetchLatestRelease;
  fetchCpaReleaseByTag: typeof fetchCpaReleaseByTag;
  downloadToFile: typeof downloadToFile;
  fetchChecksums: typeof fetchChecksums;
  extractArchive: typeof extractArchive;
  readCurrentRuntimeVersion: typeof readCurrentRuntimeVersion;
};

async function downloadFirstAvailableAsset(
  candidates: CpaReleaseAsset[],
  downloadDir: string,
  reporter: UpdateReporter,
  download: typeof downloadToFile,
): Promise<{ picked: CpaReleaseAsset; archivePath: string }> {
  let lastError: HttpStatusError | undefined;
  for (const picked of candidates) {
    const archivePath = path.join(downloadDir, picked.assetName);
    try {
      await download(picked.url, archivePath, {
        label: picked.assetName,
        maxBytes: MAX_BINARY_ARCHIVE_BYTES,
        onProgress: (event) => reporter.progress?.(event),
      });
      return { picked, archivePath };
    } catch (error) {
      if (!(error instanceof HttpStatusError) || error.status !== 404) throw error;
      lastError = error;
    }
  }
  // The caller has already rejected an empty candidate list.
  throw lastError;
}

/**
 * Preparation owns an update-only lease. Downloads, extraction, copy/fsync and
 * temp cleanup never hold the lifecycle lock. Commit re-reads the current binary
 * and process state, so a stop/start during preparation is respected.
 */
export async function updateBinary(
  home: string,
  options?: {
    version?: string;
    force?: boolean;
    insecure?: boolean;
    reporter?: UpdateReporter;
    deps?: BinaryUpdateDeps & Partial<BinaryPrepareDeps>;
  },
): Promise<BinaryUpdateResult> {
  const reporter = options?.reporter ?? silentUpdateReporter;
  const deps = {
    ...defaultBinaryUpdateDeps,
    fetchLatestRelease,
    fetchCpaReleaseByTag,
    downloadToFile,
    fetchChecksums,
    extractArchive,
    readCurrentRuntimeVersion,
    ...options?.deps,
  };
  return withMiniCpaUpdateLock("update", async () => {
    await cleanupPreviousUpdateOperations();
    const cleanup = await cleanupTempFiles({ maxEntries: 32 });
    for (const failure of cleanup.failures) reporter.warn(`Warning: could not remove ${failure}`);
    const initialVersion = recordedVersion(home);
    const discovered = options?.version
      ? await deps.fetchCpaReleaseByTag(options.version)
      : await deps.fetchLatestRelease(CPA_REPO);
    const targetVersion = normalizeTagVersion(discovered.tag);
    const maySkip = !options?.version && !options?.force;

    // The normal already-current path downloads nothing. If a recovered/changed
    // binary differs, release the lifecycle lock before preparing its replacement.
    if (maySkip && initialVersion === targetVersion) {
      const skipped = await withMiniCpaLock("update", async () => {
        const current = await deps.readCurrentRuntimeVersion(home);
        if (current !== targetVersion) return undefined;
        return {
          version: targetVersion,
          previousVersion: current,
          skipped: true,
          restarted: false,
        };
      });
      if (skipped) return skipped;
    }

    const { version, candidates, checksumUrl } = resolveCpaRelease(discovered);
    if (candidates.length === 0) {
      throw new Error(
        `No release asset for ${process.platform}/${process.arch}. Tried: ${cpaAssetNameCandidates(version, process.platform, process.arch).join(", ")}`,
      );
    }
    const operation = miniCpaTempOperationDir();
    const transaction = new RuntimeBinaryTransaction(home);
    try {
      const { picked, archivePath } = await downloadFirstAvailableAsset(
        candidates,
        operation,
        reporter,
        deps.downloadToFile,
      );
      if (!options?.insecure) {
        await verifyArchiveChecksum(
          await deps.fetchChecksums(checksumUrl),
          archivePath,
          picked.assetName,
        );
      } else {
        reporter.warn("Warning: --insecure skips archive integrity verification");
      }
      const extractedExe = await deps.extractArchive(archivePath, path.join(operation, "extract"));
      transaction.prepare(extractedExe);

      return await withMiniCpaLock("update", async () => {
        const wasRunning = !!(await deps.resolveRunning(home));
        const currentVersion = await deps.readCurrentRuntimeVersion(home);
        if (maySkip && currentVersion === version) {
          return { version, previousVersion: currentVersion, skipped: true, restarted: false };
        }
        const { restarted } = await installBinaryPhase(
          home,
          {
            version,
            wasRunning,
            currentVersion,
            transaction,
          },
          deps,
          reporter,
        );
        return { version, previousVersion: currentVersion, skipped: false, restarted };
      });
    } finally {
      transaction.discard();
      await removeTempOperation(operation, (message) => reporter.warn(message));
    }
  });
}
