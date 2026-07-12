import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import {
  ensureDir,
  executableName,
  miniCpaTempDownloadsDir,
  miniCpaTempExtractDir,
} from "../paths.js";
import { resolveRunning, startDaemon, stopDaemon } from "../process/lifecycle.js";
import { installRuntimeBinary } from "../process/runtime.js";
import { readInstallState, writeInstallState } from "../state.js";
import { sha256File } from "../util.js";
import {
  downloadToFile,
  fetchChecksums,
  fetchCpaReleaseByTag,
  fetchLatestCpaRelease,
  normalizeTagVersion,
  pickReleaseAsset,
  type GhRelease,
} from "./github.js";

async function extractArchive(archivePath: string, destDir: string): Promise<string> {
  const exeName = executableName();
  fs.mkdirSync(destDir, { recursive: true });

  if (archivePath.endsWith(".zip")) {
    const zip = new AdmZip(archivePath);
    const entry = zip
      .getEntries()
      .find((e) => !e.isDirectory && path.basename(e.entryName) === exeName);
    if (!entry) throw new Error(`${exeName} not found in ${archivePath}`);
    const out = path.join(destDir, exeName);
    fs.writeFileSync(out, entry.getData());
    return out;
  }

  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    await tar.x({ file: archivePath, cwd: destDir });
    const direct = path.join(destDir, exeName);
    if (fs.existsSync(direct)) return direct;
    const nested = fs
      .readdirSync(destDir, { recursive: true })
      .map((p) => String(p))
      .find((p) => path.basename(p) === exeName);
    if (!nested) throw new Error(`${exeName} not found in ${archivePath}`);
    return path.join(destDir, nested);
  }

  throw new Error(`Unsupported archive: ${archivePath}`);
}

async function verifyChecksum(
  checksums: Map<string, string>,
  archiveName: string,
  exePath: string,
): Promise<void> {
  if (checksums.size === 0) return;
  const exeName = executableName();
  const keys = [`${archiveName}/${exeName}`, exeName, path.basename(exePath)];
  const expected = keys.map((k) => checksums.get(k)).find(Boolean);
  if (!expected) return;
  const actual = sha256File(exePath);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${exeName}`);
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
  const state = readInstallState(home);
  const release = await fetchLatestCpaRelease();
  const latest = normalizeTagVersion(release.tag_name);
  const current = state.runtimeVersion;
  return {
    current,
    latest,
    upToDate: !!current && current === latest,
  };
}

/**
 * Replace CPA binary in place.
 * - Running process is stopped automatically, then restarted after success.
 * - Already-latest installs are skipped unless `force` or a specific `version` is requested.
 * - If we stopped the process and the update fails, we try to start the previous binary again.
 */
export async function updateBinary(
  home: string,
  options?: { version?: string; force?: boolean },
): Promise<BinaryUpdateResult> {
  const wasRunning = !!resolveRunning(home);
  const state = readInstallState(home);

  const release: GhRelease = options?.version
    ? await fetchCpaReleaseByTag(options.version)
    : await fetchLatestCpaRelease();

  const version = normalizeTagVersion(release.tag_name);
  const alreadyLatest =
    !options?.version && !!state.runtimeVersion && state.runtimeVersion === version;

  if (alreadyLatest && !options?.force) {
    return { version, changed: false, skipped: true, restarted: false };
  }

  if (wasRunning) {
    console.log("Stopping CPA for binary replace…");
    await stopDaemon(home);
  }

  try {
    const { assetName, url } = pickReleaseAsset(release, process.platform, process.arch);
    ensureDir(miniCpaTempDownloadsDir());
    const archivePath = path.join(miniCpaTempDownloadsDir(), assetName);

    await downloadToFile(url, archivePath, { label: assetName });
    const checksums = await fetchChecksums(release);

    const staging = miniCpaTempExtractDir();
    try {
      const extractedExe = await extractArchive(archivePath, staging);
      await verifyChecksum(checksums, assetName, extractedExe);
      installRuntimeBinary(home, version, extractedExe);

      const next = readInstallState(home);
      writeInstallState(home, {
        ...next,
        cpaHome: home,
        runtimeVersion: version,
        lastUpdateCheck: new Date().toISOString(),
      });
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      try {
        fs.unlinkSync(archivePath);
      } catch {
        /* ignore */
      }
    }

    let restarted = false;
    if (wasRunning) {
      console.log("Restarting CPA…");
      await startDaemon(home);
      restarted = true;
    }

    return { version, changed: true, skipped: false, restarted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!wasRunning) throw err;

    try {
      console.error("Update failed; attempting to restart previous CPA…");
      await startDaemon(home);
      throw new Error(`${msg}\nPrevious CPA was restarted after failed update.`);
    } catch (restartErr) {
      if (restartErr instanceof Error && restartErr.message.includes("Previous CPA was restarted")) {
        throw restartErr;
      }
      const rmsg = restartErr instanceof Error ? restartErr.message : String(restartErr);
      throw new Error(`${msg}\nAlso failed to restart CPA: ${rmsg}\nRun: cpa start`);
    }
  }
}
