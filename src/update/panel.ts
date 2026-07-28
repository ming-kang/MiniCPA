import fs from "node:fs";
import path from "node:path";
import { getPanelRepository, readCpaConfig, type CpaConfig } from "../config-yaml.js";
import { writeFileAtomic } from "../fs-atomic.js";
import { cpaLayout, ensureDir, miniCpaTempDownloadDir } from "../paths.js";
import { readInstallState, type InstallState, patchInstallState } from "../state.js";
import { removeDirBestEffort, sha256File } from "../util.js";
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

/**
 * Why `updatePanel` left management.html alone. Callers render a different line
 * per reason: "already-current" is a no-op success, "config-opt-out" means the
 * user asked MiniCPA never to touch the panel.
 */
export type PanelSkipReason = "already-current" | "config-opt-out";

export type PanelUpdateResult = {
  /**
   * Version the panel is left at. Empty string only for a `config-opt-out` skip
   * with nothing recorded in install.json — callers must render that case from
   * `reason`, never as a version.
   */
  version: string;
  skipped: boolean;
  /** Set whenever `skipped` is true. */
  reason?: PanelSkipReason;
};

/**
 * How the panel update was requested. `"auto"` is the implicit panel leg of a
 * plain `cpa update`; `"explicit"` is a user-typed `cpa update --panel`. The
 * `disable-auto-update-panel` opt-out only vetoes the `"auto"` leg.
 */
export type PanelUpdateTrigger = "auto" | "explicit";

/**
 * Honour CLIProxyAPI's `remote-management.disable-auto-update-panel` opt-out:
 * users who pin or hand-patch management.html must not have it replaced by a
 * plain `cpa update`.
 */
export function isPanelAutoUpdateDisabled(config: CpaConfig): boolean {
  return config["remote-management"]?.["disable-auto-update-panel"] === true;
}

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

export type ResolvedPanelAsset = {
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

/** Network seam: tests drive the panel flows without touching GitHub. */
export type PanelUpdateDeps = {
  resolveAsset(home: string): Promise<ResolvedPanelAsset>;
  download: typeof downloadToFile;
};

const realPanelUpdateDeps: PanelUpdateDeps = {
  resolveAsset: resolveLatestPanelAsset,
  download: downloadToFile,
};

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

/**
 * Report the installed vs latest panel version.
 *
 * When `remote-management.disable-auto-update-panel` is set the panel is pinned
 * on purpose, so it is reported as up to date: `cpa update check` is a scripted
 * health gate, and a panel `cpa update` is configured never to replace must not
 * hold that gate at exit 1 forever. `autoUpdateDisabled` lets callers say *why*
 * instead of claiming a stale panel is current.
 */
export async function checkPanelUpdate(
  home: string,
  deps: PanelUpdateDeps = realPanelUpdateDeps,
): Promise<{
  current?: string;
  latest: string;
  upToDate: boolean;
  autoUpdateDisabled: boolean;
}> {
  const layout = cpaLayout(home);
  const { version: latest, expectedDigest } = await deps.resolveAsset(home);
  const state = readInstallState(home);
  const intact =
    isInstalledPanelIntact(layout.managementHtml, state) && state.panelSha256 === expectedDigest;
  const current = intact ? state.panelVersion : undefined;
  const autoUpdateDisabled = isPanelAutoUpdateDisabled(readCpaConfig(layout.configFile));
  return {
    current,
    latest,
    upToDate: autoUpdateDisabled || (!!current && current === latest),
    autoUpdateDisabled,
  };
}

/**
 * Replace management.html. Skips when already latest unless force.
 *
 * The `disable-auto-update-panel` opt-out only vetoes the implicit (`"auto"`)
 * leg of a plain `cpa update`: a user-typed `cpa update --panel` (`"explicit"`)
 * is a direct request and still runs, as does any `--force` run. The opt-out
 * skip happens before any network call.
 */
export async function updatePanel(
  home: string,
  options?: { force?: boolean; trigger?: PanelUpdateTrigger; reporter?: UpdateReporter },
  deps: PanelUpdateDeps = realPanelUpdateDeps,
): Promise<PanelUpdateResult> {
  const reporter = options?.reporter ?? silentUpdateReporter;
  const layout = cpaLayout(home);
  const trigger = options?.trigger ?? "auto";

  if (
    trigger === "auto" &&
    isPanelAutoUpdateDisabled(readCpaConfig(layout.configFile)) &&
    !options?.force
  ) {
    reporter.warn(
      "Panel update skipped: remote-management.disable-auto-update-panel is true in config.yaml (use --force to override).",
    );
    return {
      version: readInstallState(home).panelVersion ?? "",
      skipped: true,
      reason: "config-opt-out",
    };
  }

  const { repo, version, asset, expectedDigest } = await deps.resolveAsset(home);
  const state = readInstallState(home);

  if (isPanelCurrent(state, layout.managementHtml, version, expectedDigest) && !options?.force) {
    return { version, skipped: true, reason: "already-current" };
  }

  const downloadDir = miniCpaTempDownloadDir("panel-");
  const cachePath = path.join(downloadDir, "management.html");
  try {
    await deps.download(releaseAssetDownloadUrl(repo, asset), cachePath, {
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

    return { version, skipped: false };
  } finally {
    // Never let temp cleanup turn a completed update into a reported failure.
    removeDirBestEffort(downloadDir, (message) => reporter.warn(message));
  }
}
