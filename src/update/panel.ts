import fs from "node:fs";
import path from "node:path";
import { getPanelRepository, readCpaConfig } from "../config-yaml.js";
import { writeFileAtomic } from "../fs-atomic.js";
import { cpaLayout, ensureDir, miniCpaTempDownloadDir } from "../paths.js";
import { readInstallState, type InstallState, patchInstallState } from "../state.js";
import { sha256File } from "../util.js";
import {
  downloadToFile,
  fetchLatestReleaseViaApi,
  normalizeTagVersion,
  parseGithubDigest,
  releaseAssetDownloadUrl,
  repoFromPanelUrl,
  type GhAsset,
} from "./github-client.js";
import { silentUpdateReporter, type UpdateReporter } from "./reporter.js";

const MAX_PANEL_BYTES = 20 * 1024 * 1024;

export type PanelUpdateResult = {
  version: string;
  changed: boolean;
  skipped: boolean;
};

/** True only when the on-disk panel matches the version and digest MiniCPA recorded. */
export function isInstalledPanelIntact(
  managementHtml: string,
  state: Pick<InstallState, "panelVersion" | "panelSha256">,
): boolean {
  if (!state.panelVersion || !state.panelSha256 || !fs.existsSync(managementHtml)) return false;
  try {
    return sha256File(managementHtml) === state.panelSha256;
  } catch {
    return false;
  }
}

export function requireGithubAssetDigest(digest: string | undefined): string {
  const parsed = parseGithubDigest(digest);
  if (!parsed) {
    throw new Error(
      "management.html has no GitHub SHA-256 digest; refusing unverified panel update",
    );
  }
  return parsed;
}

/** Basic sanity and integrity checks for a downloaded management panel. */
export function assertPanelContentSane(filePath: string, expectedDigest?: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error("management.html download missing on disk");
  }
  const stat = fs.statSync(filePath);
  if (stat.size < 32) {
    throw new Error("management.html download is empty or too small");
  }
  if (stat.size > MAX_PANEL_BYTES) {
    throw new Error("management.html download is unreasonably large");
  }
  const fd = fs.openSync(filePath, "r");
  let head = "";
  try {
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    head = buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  if (!/<\s*(!doctype|html|script|meta)/i.test(head)) {
    throw new Error("management.html does not look like HTML (refusing to install)");
  }
  if (expectedDigest) {
    const actual = sha256File(filePath);
    if (actual !== expectedDigest) {
      throw new Error("management.html digest mismatch (GitHub asset digest)");
    }
  }
}

type ResolvedPanelAsset = {
  repo: string;
  /** Normalized latest release version. */
  version: string;
  asset: GhAsset;
  /** Required GitHub SHA-256 asset digest. */
  expectedDigest: string;
};

/** Shared preamble: config → repo → latest release → management.html asset → digest. */
async function resolveLatestPanelAsset(home: string): Promise<ResolvedPanelAsset> {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  const repo = repoFromPanelUrl(getPanelRepository(cfg));
  const release = await fetchLatestReleaseViaApi(repo);
  const version = normalizeTagVersion(release.tag_name);
  const asset = release.assets.find((candidate) => candidate.name === "management.html");
  if (!asset) throw new Error(`management.html not found in ${repo} ${release.tag_name}`);
  const expectedDigest = requireGithubAssetDigest(asset.digest);
  return { repo, version, asset, expectedDigest };
}

/**
 * True when the recorded install matches the latest digest and is intact on disk.
 * `checkPanelUpdate` intentionally omits the version equality: `current` reports
 * the installed version whenever the on-disk panel is verifiably the recorded one.
 */
export function isPanelCurrent(
  state: InstallState,
  managementHtml: string,
  version: string,
  expectedDigest: string,
): boolean {
  return (
    state.panelVersion === version &&
    state.panelSha256 === expectedDigest &&
    isInstalledPanelIntact(managementHtml, state)
  );
}

export async function checkPanelUpdate(home: string): Promise<{
  current?: string;
  latest: string;
  upToDate: boolean;
}> {
  const layout = cpaLayout(home);
  const { version: latest, expectedDigest } = await resolveLatestPanelAsset(home);
  const state = readInstallState(home);
  const intact =
    isInstalledPanelIntact(layout.managementHtml, state) &&
    state.panelSha256 === expectedDigest;
  const current = intact ? state.panelVersion : undefined;
  return {
    current,
    latest,
    upToDate: !!current && current === latest,
  };
}

/** Replace management.html. Skips when already latest unless force. */
export async function updatePanel(
  home: string,
  options?: { force?: boolean; reporter?: UpdateReporter },
): Promise<PanelUpdateResult> {
  const reporter = options?.reporter ?? silentUpdateReporter;
  const layout = cpaLayout(home);
  const { repo, version, asset, expectedDigest } = await resolveLatestPanelAsset(home);
  const state = readInstallState(home);

  if (isPanelCurrent(state, layout.managementHtml, version, expectedDigest) && !options?.force) {
    return { version, changed: false, skipped: true };
  }

  const downloadDir = miniCpaTempDownloadDir("panel-");
  const cachePath = path.join(downloadDir, "management.html");
  try {
    await downloadToFile(releaseAssetDownloadUrl(repo, asset), cachePath, {
      label: "management.html",
      maxBytes: MAX_PANEL_BYTES,
      onProgress: (event) => reporter.progress?.(event),
    });

    assertPanelContentSane(cachePath, expectedDigest);

    ensureDir(layout.staticDir);
    writeFileAtomic(layout.managementHtml, fs.readFileSync(cachePath));

    patchInstallState(home, {
      panelVersion: version,
      panelSha256: sha256File(layout.managementHtml),
      lastUpdateCheck: new Date().toISOString(),
    });

    return { version, changed: true, skipped: false };
  } finally {
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}
