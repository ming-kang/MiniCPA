import fs from "node:fs";
import path from "node:path";
import { getPanelRepository, readCpaConfig } from "../config-yaml.js";
import { writeFileAtomic } from "../fs-atomic.js";
import { cpaLayout, ensureDir, miniCpaTempDownloadDir } from "../paths.js";
import { readInstallState, type InstallState, writeInstallState } from "../state.js";
import { sha256File } from "../util.js";
import {
  downloadToFile,
  fetchLatestRelease,
  normalizeTagVersion,
  parseGithubDigest,
  releaseAssetDownloadUrl,
  repoFromPanelUrl,
} from "./github.js";

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

/** Basic sanity checks for a downloaded management panel (not a full integrity proof). */
export function assertPanelContentSane(filePath: string, expectedDigest?: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error("management.html download missing on disk");
  }
  const stat = fs.statSync(filePath);
  if (stat.size < 32) {
    throw new Error("management.html download is empty or too small");
  }
  if (stat.size > 20 * 1024 * 1024) {
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

export async function checkPanelUpdate(home: string): Promise<{
  current?: string;
  latest: string;
  upToDate: boolean;
}> {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  const repo = repoFromPanelUrl(getPanelRepository(cfg));
  const release = await fetchLatestRelease(repo);
  const latest = normalizeTagVersion(release.tag_name);
  const state = readInstallState(home);
  const intact = isInstalledPanelIntact(layout.managementHtml, state);
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
  options?: { force?: boolean },
): Promise<PanelUpdateResult> {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  const repo = repoFromPanelUrl(getPanelRepository(cfg));
  const release = await fetchLatestRelease(repo);
  const version = normalizeTagVersion(release.tag_name);
  const state = readInstallState(home);

  if (
    state.panelVersion === version &&
    isInstalledPanelIntact(layout.managementHtml, state) &&
    !options?.force
  ) {
    return { version, changed: false, skipped: true };
  }

  const asset = release.assets.find((a) => a.name === "management.html");
  if (!asset) throw new Error(`management.html not found in ${repo} ${release.tag_name}`);

  const downloadDir = miniCpaTempDownloadDir("panel-");
  const cachePath = path.join(downloadDir, "management.html");
  try {
    await downloadToFile(releaseAssetDownloadUrl(repo, asset), cachePath, {
      label: "management.html",
    });

    assertPanelContentSane(cachePath, parseGithubDigest(asset.digest));

    ensureDir(layout.staticDir);
    writeFileAtomic(layout.managementHtml, fs.readFileSync(cachePath));

    const next = readInstallState(home);
    writeInstallState(home, {
      ...next,
      cpaHome: home,
      panelVersion: version,
      panelSha256: sha256File(layout.managementHtml),
      lastUpdateCheck: new Date().toISOString(),
    });

    return { version, changed: true, skipped: false };
  } finally {
    fs.rmSync(downloadDir, { recursive: true, force: true });
  }
}
