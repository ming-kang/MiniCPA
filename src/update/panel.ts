import fs from "node:fs";
import path from "node:path";
import { getPanelRepository, readCpaConfig, type CpaConfig } from "../config-yaml.js";
import { writeFileAtomic } from "../fs-atomic.js";
import { cpaLayout, ensureDir, miniCpaTempDownloadDir } from "../paths.js";
import { readInstallState, type InstallState, patchInstallState } from "../state.js";
import { removeDirBestEffort, sha256File } from "../util.js";
import { downloadToFile } from "./download.js";
import { parseGithubDigest } from "./checksum.js";
import {
  fetchLatestRelease,
  normalizeTagVersion,
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
  /** Recorded version before this operation, when known. */
  previousVersion?: string;
  /** Set whenever `skipped` is true. */
  reason?: PanelSkipReason;
};

/**
 * How the panel update was requested. `"auto"` is the implicit panel leg of a
 * plain `cpa update`; `"explicit"` is an install requested by `cpa init` or
 * `cpa update --panel`. The opt-out only vetoes the `"auto"` leg.
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
  /**
   * GitHub SHA-256 asset digest when available (only REST API fallback payloads
   * carry one). Verified when present; the default browser-discovery path
   * synthesizes download URLs without touching the API, so no digest exists
   * there by design. That fail-open posture is a deliberate trade-off: GitHub
   * publishes no checksum asset for management.html today, so installs rely on
   * the sanity checks below plus the install-time SHA-256 recorded in
   * `install.json`. If upstream ever ships a checksum source for the panel,
   * restore mandatory digest verification here.
   */
  expectedDigest?: string;
};

/** Shared preamble: config → repo → latest release → management.html asset → digest. */
async function resolveLatestPanelAsset(home: string): Promise<ResolvedPanelAsset> {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  const repo = repoFromPanelUrl(getPanelRepository(cfg));
  // Same quota-free discovery as CPA binary updates: resolve the latest tag via
  // the github.com redirect and synthesize the browser download URL. The REST
  // API is only a fallback (whose payloads may also supply an asset digest).
  const release = await fetchLatestRelease(repo, () => ["management.html"]);
  const version = normalizeTagVersion(release.tag_name);
  const asset = release.assets.find((candidate) => candidate.name === "management.html");
  if (!asset) throw new Error(`management.html not found in ${repo} ${release.tag_name}`);
  return { repo, version, asset, expectedDigest: parseGithubDigest(asset.digest) };
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
 * True when the recorded install matches the latest version and is intact on
 * disk (on-disk bytes equal the SHA-256 recorded at install time). Upstream
 * re-published assets under the same tag are noticed only at the next version
 * bump — the same trade-off the CLIProxyAPI binary leg makes with its
 * version-string comparison.
 */
export function isPanelCurrent(
  state: InstallState,
  managementHtml: string,
  version: string,
): boolean {
  return state.panelVersion === version && isInstalledPanelIntact(managementHtml, state);
}

/**
 * Report the installed vs latest panel version.
 *
 * When `remote-management.disable-auto-update-panel` is set the panel is pinned
 * on purpose. It remains a passing result for the scripted health gate, while
 * `autoUpdateDisabled` lets callers report the opt-out instead of claiming the
 * installed panel is current.
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
  const { version: latest } = await deps.resolveAsset(home);
  const state = readInstallState(home);
  const intact = isInstalledPanelIntact(layout.managementHtml, state);
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
 * leg of a plain `cpa update`: `cpa init` and `cpa update --panel` (`"explicit"`)
 * are direct requests and still run, as does any `--force` run. The opt-out
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
    // No warning here: the command layer renders the returned reason, and both
    // would print for the same skip.
    const previousVersion = readInstallState(home).panelVersion;
    return {
      version: previousVersion ?? "",
      previousVersion,
      skipped: true,
      reason: "config-opt-out",
    };
  }

  const { repo, version, asset, expectedDigest } = await deps.resolveAsset(home);
  const state = readInstallState(home);

  if (isPanelCurrent(state, layout.managementHtml, version) && !options?.force) {
    return {
      version,
      previousVersion: state.panelVersion,
      skipped: true,
      reason: "already-current",
    };
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

    return { version, previousVersion: state.panelVersion, skipped: false };
  } finally {
    // Never let temp cleanup turn a completed update into a reported failure.
    removeDirBestEffort(downloadDir, (message) => reporter.warn(message));
  }
}
