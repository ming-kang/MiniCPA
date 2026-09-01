import {
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

const CPA_RELEASE_TARGETS = [
  ["win32", "x64"],
  ["win32", "arm64"],
  ["darwin", "x64"],
  ["darwin", "arm64"],
  ["linux", "x64"],
  ["linux", "arm64"],
] as const satisfies readonly (readonly [SupportedPlatform, SupportedArch])[];

function supportedTarget(
  platform: NodeJS.Platform,
  arch: string,
): {
  platform: SupportedPlatform;
  arch: SupportedArch;
} {
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported CPU architecture for CLIProxyAPI updates: ${platform}/${arch}`);
  }
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Unsupported platform for CLIProxyAPI updates: ${platform}/${arch}`);
  }
  return { platform, arch };
}

function assetNamesForTarget(
  normalizedVersion: string,
  platform: SupportedPlatform,
  arch: SupportedArch,
): string[] {
  return CPA_ASSET_SUFFIXES[platform][arch].map(
    (suffix) => `CLIProxyAPI_${normalizedVersion}_${suffix}`,
  );
}

/** Known public CPA binary asset names for a version (plus checksums). */
export function cpaReleaseAssetNames(version: string): string[] {
  const normalizedVersion = normalizeTagVersion(version);
  return [
    ...CPA_RELEASE_TARGETS.flatMap(([platform, arch]) =>
      assetNamesForTarget(normalizedVersion, platform, arch),
    ),
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
  const target = supportedTarget(platform, arch);
  return assetNamesForTarget(normalizeTagVersion(version), target.platform, target.arch);
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
    const asset = release.assets.find((candidate) => candidate.name === name);
    if (asset) {
      picked.push({
        assetName: asset.name,
        url: releaseAssetDownloadUrl(repo, asset),
        asset,
      });
    }
  }

  return picked;
}
