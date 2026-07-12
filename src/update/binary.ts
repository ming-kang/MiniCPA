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
import { readInstallState, writeInstallState } from "../state.js";
import { sha256File } from "../util.js";
import { installRuntimeBinary } from "../process/runtime.js";
import { resolveRunning, stopDaemon } from "../process/lifecycle.js";
import {
  downloadToFile,
  fetchChecksums,
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
      .find((p) => p.endsWith(exeName) || p === exeName);
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

export async function updateBinary(
  home: string,
  options?: { version?: string; force?: boolean },
): Promise<BinaryUpdateResult> {
  const running = resolveRunning(home);
  if (running && !options?.force) {
    throw new Error("CPA is running. Run: cpa stop   (or use --force to only stage download)");
  }
  if (running) await stopDaemon(home);

  const release: GhRelease = options?.version
    ? await resolveReleaseByVersion(options.version)
    : await fetchLatestCpaRelease();

  const version = normalizeTagVersion(release.tag_name);
  const { assetName, url } = pickReleaseAsset(release, process.platform, process.arch);
  ensureDir(miniCpaTempDownloadsDir());
  const archivePath = path.join(miniCpaTempDownloadsDir(), assetName);

  await downloadToFile(url, archivePath);
  const checksums = await fetchChecksums(release);

  const staging = miniCpaTempExtractDir();
  try {
    const extractedExe = await extractArchive(archivePath, staging);
    await verifyChecksum(checksums, assetName, extractedExe);
    installRuntimeBinary(home, version, extractedExe);

    const state = readInstallState(home);
    writeInstallState(home, {
      ...state,
      cpaHome: home,
      runtimeVersion: version,
      lastUpdateCheck: new Date().toISOString(),
      channel: "stable",
    });

    return { version, changed: true };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      fs.unlinkSync(archivePath);
    } catch {
      /* ignore */
    }
  }
}

async function resolveReleaseByVersion(version: string): Promise<GhRelease> {
  const tag = version.startsWith("v") ? version : `v${version}`;
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "MiniCPA",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/tags/${tag}`, {
    headers,
  });
  if (!res.ok) throw new Error(`Release not found: ${tag}`);
  return (await res.json()) as GhRelease;
}