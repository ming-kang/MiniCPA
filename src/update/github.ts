import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { httpFetch } from "../http.js";
import { formatBytes } from "../util.js";

export type GhAsset = {
  id?: number;
  name: string;
  browser_download_url: string;
  url?: string;
  digest?: string;
};

export type GhRelease = {
  tag_name: string;
  name: string;
  published_at: string;
  assets: GhAsset[];
};

export const CPA_REPO = "router-for-me/CLIProxyAPI";
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** Auth for remaining API fallback paths. Prefers GITHUB_TOKEN, then GH_TOKEN (gh CLI). */
export function githubAuthToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  return token && token.trim() ? token.trim() : undefined;
}

function githubHeaders(mode: "json" | "download" | "browser" = "browser"): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "MiniCPA",
  };
  if (mode === "json") headers.Accept = "application/vnd.github+json";
  else if (mode === "download") headers.Accept = "application/octet-stream";
  // Never attach tokens to public browser downloads (only API paths).
  if (mode !== "browser") {
    const token = githubAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** Safe public release tags only (semver-ish). */
export function isSafeReleaseTag(tag: string): boolean {
  const t = tag.trim();
  // Allow v1.2.3, 1.2.3, pre-release / build metadata common on GitHub.
  return /^v?\d+(\.\d+){0,3}([._+-][A-Za-z0-9._+-]*)?$/i.test(t);
}

/** Normalize tag to the form used in github.com/releases/download URLs (leading v). */
export function ensureReleaseTag(tag: string): string {
  const trimmed = tag.trim();
  if (!trimmed) throw new Error("Empty release tag");
  if (!isSafeReleaseTag(trimmed)) {
    throw new Error(
      `Invalid release tag "${trimmed}". Use a version like 7.2.92 or v7.2.92.`,
    );
  }
  return trimmed.startsWith("v") || trimmed.startsWith("V")
    ? `v${trimmed.slice(1)}`
    : `v${trimmed}`;
}

/** Public browser download URL — does not consume GitHub REST rate limit. */
export function browserReleaseAssetUrl(repo: string, tag: string, assetName: string): string {
  const releaseTag = ensureReleaseTag(tag);
  const encodedTag = encodeURIComponent(releaseTag);
  const encoded = assetName
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://github.com/${repo}/releases/download/${encodedTag}/${encoded}`;
}

/**
 * Prefer browser release URLs (no REST quota). Fall back to API asset endpoints only when
 * no browser URL is available (e.g. partial API payloads for private assets).
 */
export function releaseAssetDownloadUrl(repo: string, asset: GhAsset): string {
  if (asset.browser_download_url && !isApiAssetUrl(asset.browser_download_url)) {
    return asset.browser_download_url;
  }
  if (typeof asset.id === "number" && Number.isFinite(asset.id)) {
    return `https://api.github.com/repos/${repo}/releases/assets/${asset.id}`;
  }
  if (asset.url && asset.url.includes("/releases/assets/")) {
    return asset.url;
  }
  return asset.browser_download_url;
}

function isApiAssetUrl(url: string): boolean {
  return /api\.github\.com\/repos\/.+\/releases\/assets\//i.test(url);
}

/** Extract release tag from a GitHub /releases/latest Location header or final URL. */
export function parseReleaseTagFromLocation(location: string): string | undefined {
  const raw = location.trim();
  if (!raw) return undefined;

  const m =
    raw.match(/\/releases\/tag\/([^/?#]+)/i) ||
    raw.match(/(?:^|\/)tag\/([^/?#]+)/i);
  if (!m?.[1]) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function formatGitHubApiError(status: number, repo: string, context: string): string {
  const base = `GitHub API ${status} for ${repo} (${context})`;
  if (status === 403 || status === 429) {
    return (
      `${base}. REST rate limit may be exhausted; updates normally use github.com/releases ` +
      `(no token). If browser GitHub is blocked, set GITHUB_TOKEN or GH_TOKEN and retry.`
    );
  }
  return base;
}

/**
 * Resolve the latest release tag via github.com redirect (no REST rate limit).
 * Uses redirect: "manual" and reads the Location header.
 */
export async function resolveLatestReleaseTag(repo: string): Promise<string> {
  const url = `https://github.com/${repo}/releases/latest`;
  const res = await httpFetch(url, {
    headers: githubHeaders("browser"),
    redirect: "manual",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  const location = res.headers.get("location") || res.headers.get("Location");
  if (location) {
    const tag = parseReleaseTagFromLocation(location);
    if (tag) {
      if (!isSafeReleaseTag(tag)) {
        throw new Error(`Latest release tag is not a safe version string: ${tag}`);
      }
      return tag;
    }
  }

  const finalUrl = (res as { url?: string }).url;
  if (finalUrl) {
    const tag = parseReleaseTagFromLocation(finalUrl);
    if (tag && isSafeReleaseTag(tag)) return tag;
  }

  throw new Error(
    `Could not resolve latest release tag for ${repo} via github.com ` +
      `(HTTP ${res.status}, no usable Location).`,
  );
}

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
    `CLIProxyAPI_${v}_linux_amd64.tar.gz`,
    `CLIProxyAPI_${v}_linux_aarch64.tar.gz`,
    `CLIProxyAPI_${v}_linux_arm64.tar.gz`,
    `CLIProxyAPI_${v}_linux_amd64_no-plugin.tar.gz`,
    `CLIProxyAPI_${v}_linux_amd64_portable.tar.gz`,
    "checksums.txt",
  ];
}

/** Build a release object with browser download URLs (no API asset list needed). */
export function synthesizePublicRelease(
  repo: string,
  tag: string,
  assetNames: string[],
): GhRelease {
  const releaseTag = ensureReleaseTag(tag);
  return {
    tag_name: releaseTag,
    name: releaseTag,
    published_at: "",
    assets: assetNames.map((name) => ({
      name,
      browser_download_url: browserReleaseAssetUrl(repo, releaseTag, name),
    })),
  };
}

function defaultAssetNamesForRepo(repo: string, tag: string): string[] {
  if (repo === CPA_REPO) return cpaReleaseAssetNames(tag);
  return ["management.html"];
}

async function fetchLatestReleaseViaApi(repo: string): Promise<GhRelease> {
  const res = await httpFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubHeaders("json"),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(formatGitHubApiError(res.status, repo, "releases/latest"));
  }
  return (await res.json()) as GhRelease;
}

/**
 * Latest release metadata. Prefers github.com redirect + synthetic browser asset URLs
 * (avoids REST rate limits). Falls back to the GitHub REST API when browser discovery fails.
 */
export async function fetchLatestRelease(repo: string): Promise<GhRelease> {
  try {
    const tag = await resolveLatestReleaseTag(repo);
    return synthesizePublicRelease(repo, tag, defaultAssetNamesForRepo(repo, tag));
  } catch (browserErr) {
    try {
      return await fetchLatestReleaseViaApi(repo);
    } catch (apiErr) {
      const browserMsg = browserErr instanceof Error ? browserErr.message : String(browserErr);
      const apiMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      throw new Error(
        `Failed to resolve latest release for ${repo}.\n` +
          `Browser path: ${browserMsg}\n` +
          `API fallback: ${apiMsg}`,
      );
    }
  }
}

export async function fetchLatestCpaRelease(): Promise<GhRelease> {
  return fetchLatestRelease(CPA_REPO);
}

async function fetchCpaReleaseByTagViaApi(normalizedTag: string): Promise<GhRelease> {
  const res = await httpFetch(
    `https://api.github.com/repos/${CPA_REPO}/releases/tags/${normalizedTag}`,
    {
      headers: githubHeaders("json"),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Release not found: ${normalizedTag}`);
    throw new Error(formatGitHubApiError(res.status, CPA_REPO, `releases/tags/${normalizedTag}`));
  }
  return (await res.json()) as GhRelease;
}

/**
 * CPA release for a specific tag. Synthesizes browser download URLs by default.
 * With a token, API is tried first; 404 fails immediately; rate-limit/network may fall through.
 */
export async function fetchCpaReleaseByTag(tag: string): Promise<GhRelease> {
  const normalized = ensureReleaseTag(tag);
  if (githubAuthToken()) {
    try {
      return await fetchCpaReleaseByTagViaApi(normalized);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Release not found|API 404/i.test(message)) throw err;
      // Rate limit / network — public browser URLs may still work.
    }
  }
  return synthesizePublicRelease(CPA_REPO, normalized, cpaReleaseAssetNames(normalized));
}

export function repoFromPanelUrl(panelRepoUrl: string): string {
  const m = panelRepoUrl.match(/github\.com\/([^/]+\/[^/]+)/i);
  if (!m) throw new Error(`Unsupported panel repository URL: ${panelRepoUrl}`);
  return m[1]!.replace(/\.git$/, "");
}

export function normalizeTagVersion(tag: string): string {
  return tag.replace(/^v/i, "");
}

export type DownloadOptions = {
  /** Shown in progress line */
  label?: string;
  timeoutMs?: number;
  /** Override Accept / auth for GitHub API asset downloads */
  apiAsset?: boolean;
};

/** Stream download to disk with optional progress on stderr. Honors proxy env via httpFetch. */
export async function downloadToFile(
  url: string,
  dest: string,
  options?: DownloadOptions,
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const label = options?.label ?? path.basename(dest);
  const useApiAsset = options?.apiAsset ?? isApiAssetUrl(url);

  const res = await httpFetch(url, {
    headers: githubHeaders(useApiAsset ? "download" : "browser"),
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const hint =
      res.status === 404
        ? " (release or asset not found — check version/tag)"
        : res.status === 403 || res.status === 429
          ? " (rate limited or forbidden — try GITHUB_TOKEN/GH_TOKEN if using API URLs)"
          : "";
    throw new Error(`Download failed ${res.status}: ${label}${hint}`);
  }
  if (!res.body) throw new Error(`Download failed (empty body): ${label}`);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const total = Number(res.headers.get("content-length") || 0);
  let received = 0;
  let lastPct = -1;

  const nodeBody = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  nodeBody.on("data", (chunk: Buffer | string) => {
    const n = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    received += n;
    if (total > 0) {
      const pct = Math.min(100, Math.floor((received / total) * 100));
      if (pct !== lastPct && (pct % 5 === 0 || pct === 100)) {
        lastPct = pct;
        process.stderr.write(
          `\rDownloading ${label}: ${pct}% (${formatBytes(received)} / ${formatBytes(total)})`,
        );
      }
    } else if (received === n || received % (2 * 1024 * 1024) < n) {
      process.stderr.write(`\rDownloading ${label}: ${formatBytes(received)}`);
    }
  });

  try {
    await pipeline(nodeBody, fs.createWriteStream(dest));
    if (total > 0 || received > 0) process.stderr.write("\n");
    if (received === 0) {
      try {
        fs.unlinkSync(dest);
      } catch {
        /* ignore */
      }
      throw new Error(`Download failed (empty file): ${label}`);
    }
  } catch (err) {
    try {
      fs.unlinkSync(dest);
    } catch {
      /* ignore */
    }
    throw err;
  }
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

  if (platform === "win32") {
    if (arch === "arm64") {
      candidates.push(`CLIProxyAPI_${v}_windows_aarch64.zip`);
      candidates.push(`CLIProxyAPI_${v}_windows_arm64.zip`);
    }
    candidates.push(`CLIProxyAPI_${v}_windows_amd64.zip`);
  } else if (platform === "darwin") {
    if (arch === "arm64") candidates.push(`CLIProxyAPI_${v}_darwin_aarch64.tar.gz`);
    candidates.push(`CLIProxyAPI_${v}_darwin_amd64.tar.gz`);
  } else {
    if (arch === "arm64") {
      candidates.push(`CLIProxyAPI_${v}_linux_aarch64.tar.gz`);
      candidates.push(`CLIProxyAPI_${v}_linux_arm64.tar.gz`);
    }
    candidates.push(`CLIProxyAPI_${v}_linux_amd64.tar.gz`);
    candidates.push(`CLIProxyAPI_${v}_linux_amd64_no-plugin.tar.gz`);
    candidates.push(`CLIProxyAPI_${v}_linux_amd64_portable.tar.gz`);
  }
  return candidates;
}

export function pickReleaseAsset(
  release: GhRelease,
  platform: NodeJS.Platform,
  arch: string,
  repo: string = CPA_REPO,
): PickedReleaseAsset {
  const candidates = listReleaseAssetCandidates(release, platform, arch, repo);
  if (candidates.length === 0) {
    throw new Error(
      `No release asset for ${platform}/${arch}. Tried: ${cpaAssetNameCandidates(release.tag_name, platform, arch).join(", ")}`,
    );
  }
  return candidates[0]!;
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

/** Parse GitHub checksums.txt body into map of filename → sha256. */
export function parseChecksumsText(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (m) map.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return map;
}

export function parseGithubDigest(digest: string | undefined): string | undefined {
  if (!digest) return undefined;
  const m = digest.trim().match(/^sha256:([a-f0-9]{64})$/i);
  return m?.[1]?.toLowerCase();
}

export async function fetchChecksums(
  release: GhRelease,
  repo: string = CPA_REPO,
): Promise<Map<string, string>> {
  let asset = release.assets.find((a) => a.name === "checksums.txt");
  if (!asset) {
    asset = {
      name: "checksums.txt",
      browser_download_url: browserReleaseAssetUrl(repo, release.tag_name, "checksums.txt"),
    };
  }

  const url = releaseAssetDownloadUrl(repo, asset);
  const res = await httpFetch(url, {
    headers: githubHeaders(isApiAssetUrl(url) ? "download" : "browser"),
    redirect: "follow",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to download checksums.txt (HTTP ${res.status}). Use --insecure to skip integrity check.`,
    );
  }
  const map = parseChecksumsText(await res.text());
  if (map.size === 0) {
    throw new Error(
      `checksums.txt for ${release.tag_name} is empty or unparseable (use --insecure to skip)`,
    );
  }
  return map;
}
