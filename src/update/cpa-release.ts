import {
  browserReleaseAssetUrl,
  ensureReleaseTag,
  fetchReleaseByTagViaApi,
  githubAuthToken,
  normalizeTagVersion,
  releaseAssetDownloadUrl,
  synthesizePublicRelease,
  type GhAsset,
  type GhRelease,
} from "./github-client.js";

export const CPA_REPO = "router-for-me/CLIProxyAPI";

/** Known public CPA binary asset names for a version (plus checksums). */
export function cpaReleaseAssetNames(version: string): string[] {
  const v = normalizeTagVersion(version);
  return [
    // Current upstream naming (aarch64) first, then historical aliases.
    `CLIProxyAPI_${v}_windows_amd64.zip`,
    `CLIProxyAPI_${v}_windows_aarch64.zip`,
    `CLIProxyAPI_${v}_windows_arm64.zip`,
    `CLIProxyAPI_${v}_darwin_amd64.tar.gz`,
    `CLIProxyAPI_${v}_darwin_aarch64.tar.gz`,
    `CLIProxyAPI_${v}_darwin_arm64.tar.gz`,
    `CLIProxyAPI_${v}_linux_amd64.tar.gz`,
    `CLIProxyAPI_${v}_linux_aarch64.tar.gz`,
    `CLIProxyAPI_${v}_linux_arm64.tar.gz`,
    `CLIProxyAPI_${v}_linux_amd64_no-plugin.tar.gz`,
    `CLIProxyAPI_${v}_linux_amd64_portable.tar.gz`,
    "checksums.txt",
  ];
}

/**
 * CPA release for a specific tag. Synthesizes browser download URLs by default.
 * With a token, API is tried first; 404 fails immediately; rate-limit/network may fall through.
 */
export async function fetchCpaReleaseByTag(tag: string): Promise<GhRelease> {
  const normalized = ensureReleaseTag(tag);
  if (githubAuthToken()) {
    try {
      return await fetchReleaseByTagViaApi(CPA_REPO, normalized);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Release not found|API 404/i.test(message)) throw err;
      // Rate limit / network — public browser URLs may still work.
    }
  }
  return synthesizePublicRelease(CPA_REPO, normalized, cpaReleaseAssetNames(normalized));
}

export type PickedReleaseAsset = {
  assetName: string;
  /** Browser release URL when available; API asset URL only as fallback. */
  url: string;
  asset: GhAsset;
};

/** Ordered platform asset name candidates (current upstream names first). */
export function cpaAssetNameCandidates(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const v = normalizeTagVersion(version);
  const candidates: string[] = [];
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported CPU architecture for CPA updates: ${platform}/${arch}`);
  }
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Unsupported platform for CPA updates: ${platform}/${arch}`);
  }

  if (platform === "win32") {
    if (arch === "arm64") {
      candidates.push(`CLIProxyAPI_${v}_windows_aarch64.zip`);
      candidates.push(`CLIProxyAPI_${v}_windows_arm64.zip`);
    } else {
      candidates.push(`CLIProxyAPI_${v}_windows_amd64.zip`);
    }
  } else if (platform === "darwin") {
    if (arch === "arm64") {
      candidates.push(`CLIProxyAPI_${v}_darwin_aarch64.tar.gz`);
      candidates.push(`CLIProxyAPI_${v}_darwin_arm64.tar.gz`);
    } else {
      candidates.push(`CLIProxyAPI_${v}_darwin_amd64.tar.gz`);
    }
  } else {
    if (arch === "arm64") {
      candidates.push(`CLIProxyAPI_${v}_linux_aarch64.tar.gz`);
      candidates.push(`CLIProxyAPI_${v}_linux_arm64.tar.gz`);
    } else {
      candidates.push(`CLIProxyAPI_${v}_linux_amd64.tar.gz`);
      candidates.push(`CLIProxyAPI_${v}_linux_amd64_no-plugin.tar.gz`);
      candidates.push(`CLIProxyAPI_${v}_linux_amd64_portable.tar.gz`);
    }
  }
  return candidates;
}

/** All candidate assets that exist on the release (or synthetic browser URLs). */
export function listReleaseAssetCandidates(
  release: GhRelease,
  platform: NodeJS.Platform,
  arch: string,
  repo: string = CPA_REPO,
): PickedReleaseAsset[] {
  const candidates = cpaAssetNameCandidates(release.tag_name, platform, arch);
  const picked: PickedReleaseAsset[] = [];

  for (const name of candidates) {
    const asset = release.assets.find((a) => a.name === name);
    if (asset) {
      picked.push({
        assetName: asset.name,
        url: releaseAssetDownloadUrl(repo, asset),
        asset,
      });
    }
  }

  if (picked.length === 0 && release.assets.length === 0) {
    // Fully synthetic release: construct browser URLs for every candidate.
    for (const name of candidates) {
      const asset: GhAsset = {
        name,
        browser_download_url: browserReleaseAssetUrl(repo, release.tag_name, name),
      };
      picked.push({ assetName: name, url: asset.browser_download_url, asset });
    }
  }

  return picked;
}
