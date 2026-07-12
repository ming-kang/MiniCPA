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
  repoFromPanelUrl,
} from "./github.js";

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

export async function updatePanel(home: string): Promise<{ version: string }> {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  const repo = repoFromPanelUrl(getPanelRepository(cfg));
  const release = await fetchLatestRelease(repo);
  const version = normalizeTagVersion(release.tag_name);

  const asset = release.assets.find((a) => a.name === "management.html");
  if (!asset) throw new Error(`management.html not found in ${repo} ${release.tag_name}`);

  ensureDir(miniCpaTempDownloadsDir());
  const cachePath = path.join(miniCpaTempDownloadsDir(), `management-${release.tag_name}.html`);
  await downloadToFile(asset.browser_download_url, cachePath);

  fs.mkdirSync(layout.staticDir, { recursive: true });
  const tmp = `${layout.managementHtml}.tmp`;
  fs.copyFileSync(cachePath, tmp);
  fs.renameSync(tmp, layout.managementHtml);
  try {
    fs.unlinkSync(cachePath);
  } catch {
    /* ignore */
  }

  const state = readInstallState(home);
  writeInstallState(home, {
    ...state,
    cpaHome: home,
    panelVersion: version,
    panelSha256: sha256File(layout.managementHtml),
    lastUpdateCheck: new Date().toISOString(),
    channel: "stable",
  });

  return { version };
}