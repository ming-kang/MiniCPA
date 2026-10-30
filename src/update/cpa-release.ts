import { HttpStatusError } from "../http.js";
import {
  browserReleaseAssetUrl,
  ensureReleaseTag,
  fetchReleaseByTagViaApi,
  githubAuthToken,
  normalizeTagVersion,
  releaseAssetDownloadUrl,
  type GithubRelease,
} from "./github-client.js";

export const CPA_REPO = "router-for-me/CLIProxyAPI";

type SupportedPlatform = "win32" | "darwin" | "linux";
type SupportedArch = "x64" | "arm64";

/** One canonical source for current and historical upstream package labels. */
const CPA_ASSET_SUFFIXES: Record<SupportedPlatform, Record<SupportedArch, readonly string[]>> = {
  win32: {
    x64: ["windows_amd64.zip"],
    arm64: ["windows_aarch64.zip", "windows_arm64.zip"],
  },
  darwin: {
    x64: ["darwin_amd64.tar.gz"],
    arm64: ["darwin_aarch64.tar.gz", "darwin_arm64.tar.gz"],
  },
  linux: {
    x64: ["linux_amd64.tar.gz", "linux_amd64_no-plugin.tar.gz", "linux_amd64_portable.tar.gz"],
    arm64: ["linux_aarch64.tar.gz", "linux_arm64.tar.gz"],
  },
};

/** Ordered candidates for this target only; never fall back across architectures. */
export function cpaAssetNameCandidates(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported CPU architecture for CLIProxyAPI updates: ${platform}/${arch}`);
  }
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Unsupported platform for CLIProxyAPI updates: ${platform}/${arch}`);
  }
  const normalizedVersion = normalizeTagVersion(version);
  return CPA_ASSET_SUFFIXES[platform][arch].map(
    (suffix) => `CLIProxyAPI_${normalizedVersion}_${suffix}`,
  );
}

export type CpaReleaseAsset = { assetName: string; url: string };
export type CpaRelease = {
  version: string;
  candidates: CpaReleaseAsset[];
  checksumUrl: string;
};

/** Reduce discovery to the current target's downloads, without fabricating API metadata. */
export function resolveCpaRelease(
  release: GithubRelease,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CpaRelease {
  const candidates = cpaAssetNameCandidates(release.tag, platform, arch).flatMap((name) => {
    const asset = release.assets?.get(name);
    if (asset) return [{ assetName: name, url: releaseAssetDownloadUrl(CPA_REPO, asset) }];
    // Only tag-only discovery synthesizes URLs. A real API list never gains missing assets.
    return release.assets === undefined
      ? [{ assetName: name, url: browserReleaseAssetUrl(CPA_REPO, release.tag, name) }]
      : [];
  });
  const checksum = release.assets?.get("checksums.txt");
  return {
    version: normalizeTagVersion(release.tag),
    candidates,
    checksumUrl: checksum
      ? releaseAssetDownloadUrl(CPA_REPO, checksum)
      : browserReleaseAssetUrl(CPA_REPO, release.tag, "checksums.txt"),
  };
}

/** With a token try the API first; a missing pinned release must not fall through. */
export async function fetchCpaReleaseByTag(
  tag: string,
  fetchApi: typeof fetchReleaseByTagViaApi = fetchReleaseByTagViaApi,
): Promise<GithubRelease> {
  const normalized = ensureReleaseTag(tag);
  if (githubAuthToken()) {
    try {
      return await fetchApi(CPA_REPO, normalized);
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 404) throw error;
      // Rate limit / network: public URLs may still work.
    }
  }
  return { tag: normalized };
}
