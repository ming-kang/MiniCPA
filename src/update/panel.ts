import fs from "node:fs";
import path from "node:path";
import { getPanelRepository, readCpaConfig } from "../config-yaml.js";
import { cpaLayout, ensureDir, miniCpaTempDownloadsDir } from "../paths.js";
import { readInstallState, writeInstallState } from "../state.js";
import { sha256File } from "../util.js";
import {
  downloadToFile,
  fetchLatestRelease,
  normalizeTagVersion,
  releaseAssetDownloadUrl,
  repoFromPanelUrl,
} from "./github.js";

export type PanelUpdateResult = {
  version: string;
  changed: boolean;
  skipped: boolean;
};

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
  const current = state.panelVersion;
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

  if (state.panelVersion === version && !options?.force) {
    return { version, changed: false, skipped: true };
  }

  const asset = release.assets.find((a) => a.name === "management.html");
  if (!asset) throw new Error(`management.html not found in ${repo} ${release.tag_name}`);

  ensureDir(miniCpaTempDownloadsDir());
  const cachePath = path.join(miniCpaTempDownloadsDir(), `management-${release.tag_name}.html`);
  await downloadToFile(releaseAssetDownloadUrl(repo, asset), cachePath, {
    label: "management.html",
    apiAsset: true,
  });

  fs.mkdirSync(layout.staticDir, { recursive: true });
  const tmp = `${layout.managementHtml}.tmp`;
  fs.copyFileSync(cachePath, tmp);
  fs.renameSync(tmp, layout.managementHtml);
  try {
    fs.unlinkSync(cachePath);
  } catch {
    /* ignore */
  }

  const next = readInstallState(home);
  writeInstallState(home, {
    ...next,
    cpaHome: home,
    panelVersion: version,
    panelSha256: sha256File(layout.managementHtml),
    lastUpdateCheck: new Date().toISOString(),
  });

  return { version, changed: true, skipped: false };
}
