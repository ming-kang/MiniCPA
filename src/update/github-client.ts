import { httpFetch, HttpStatusError, readHttpTextBounded } from "../http.js";

export type GhAsset = {
  id?: number;
  name: string;
  browser_download_url: string;
  url?: string;
};

/** A redirect discovers only a tag; an API result also knows which assets exist. */
export type GithubRelease = {
  tag: string;
  /** Undefined means public URL discovery; an empty map means an API release with no assets. */
  assets?: Map<string, GhAsset>;
};

const API_TIMEOUT_MS = 30_000;
export const MAX_GITHUB_METADATA_BYTES = 1024 * 1024;
const GITHUB_API_BASE_URL = "https://api.github.com";

/** Auth for remaining API fallback paths. Prefers GITHUB_TOKEN, then GH_TOKEN (gh CLI). */
export function githubAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  return token?.trim() ? token.trim() : undefined;
}

export function githubHeaders(
  mode: "json" | "download" | "browser" = "browser",
): Record<string, string> {
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
    throw new Error(`Invalid release tag "${trimmed}". Use a version like 7.2.92 or v7.2.92.`);
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

/** Hosts MiniCPA will fetch release assets and checksums from. */
const ALLOWED_GITHUB_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

/**
 * True for HTTPS URLs on GitHub release / API / CDN hosts.
 * Rejects HTTP and any other host so a compromised or spoofed API payload cannot
 * redirect downloads off-platform.
 */
export function isAllowedGithubDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return ALLOWED_GITHUB_DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Prefer browser release URLs (no REST quota). Fall back to API asset endpoints only when
 * no browser URL is available (e.g. partial API payloads for private assets).
 */
export function releaseAssetDownloadUrl(repo: string, asset: GhAsset): string {
  const browser = asset.browser_download_url?.trim() ?? "";
  if (browser && !isApiAssetUrl(browser) && isAllowedGithubDownloadUrl(browser)) {
    return browser;
  }
  if (typeof asset.id === "number" && Number.isFinite(asset.id)) {
    return `https://api.github.com/repos/${repo}/releases/assets/${asset.id}`;
  }
  if (asset.url?.includes("/releases/assets/") && isAllowedGithubDownloadUrl(asset.url)) {
    return asset.url;
  }
  if (browser) {
    if (!isAllowedGithubDownloadUrl(browser)) {
      throw new Error(
        `Refusing download URL with untrusted host for ${asset.name || "asset"}: ${browser}`,
      );
    }
    return browser;
  }
  throw new Error(`No usable download URL for asset ${asset.name || "(unnamed)"}`);
}

export function isApiAssetUrl(url: string): boolean {
  return /api\.github\.com\/repos\/.+\/releases\/assets\//i.test(url);
}

/** Extract release tag from a GitHub /releases/latest Location header or final URL. */
export function parseReleaseTagFromLocation(location: string): string | undefined {
  const raw = location.trim();
  if (!raw) return undefined;

  const m = raw.match(/\/releases\/tag\/([^/?#]+)/i) || raw.match(/(?:^|\/)tag\/([^/?#]+)/i);
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
    return `${base}. REST rate limit may be exhausted — set GITHUB_TOKEN or GH_TOKEN and retry.`;
  }
  return base;
}

/**
 * Resolve the latest release tag via github.com redirect (no REST rate limit).
 * Uses redirect: "manual" and reads the Location header.
 * `baseUrl` is overridable for tests only.
 */
export async function resolveLatestReleaseTag(
  repo: string,
  baseUrl = "https://github.com",
): Promise<string> {
  const url = `${baseUrl}/${repo}/releases/latest`;
  const res = await httpFetch(url, {
    headers: githubHeaders("browser"),
    redirect: "manual",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });

  await res.body?.cancel().catch(() => {});
  const location = res.headers.get("location");
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

function validateReleaseMetadata(repo: string, release: unknown): GithubRelease {
  if (release === null || typeof release !== "object" || Array.isArray(release)) {
    throw new Error(`GitHub returned invalid release metadata for ${repo}`);
  }
  const candidate = release as { tag_name?: unknown; assets?: unknown };
  if (
    typeof candidate.tag_name !== "string" ||
    !isSafeReleaseTag(candidate.tag_name) ||
    !Array.isArray(candidate.assets)
  ) {
    throw new Error(`GitHub returned invalid release metadata for ${repo}`);
  }
  const assets = new Map<string, GhAsset>();
  for (const raw of candidate.assets) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`GitHub returned an invalid release asset for ${repo}`);
    }
    const asset = raw as Record<string, unknown>;
    if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") {
      throw new Error(`GitHub returned an invalid release asset for ${repo}`);
    }
    const browserUrl = asset.browser_download_url.trim();
    if (browserUrl && !isAllowedGithubDownloadUrl(browserUrl)) {
      throw new Error(`GitHub returned an untrusted download URL for ${repo} asset ${asset.name}`);
    }
    const url = typeof asset.url === "string" ? asset.url : undefined;
    if (url?.trim() && !isAllowedGithubDownloadUrl(url)) {
      throw new Error(`GitHub returned an untrusted asset API URL for ${repo} asset ${asset.name}`);
    }
    // Preserve first-match semantics when an API payload repeats a name.
    if (!assets.has(asset.name))
      assets.set(asset.name, {
        name: asset.name,
        browser_download_url: asset.browser_download_url,
        id: typeof asset.id === "number" ? asset.id : undefined,
        url,
      });
  }
  return { tag: candidate.tag_name, assets };
}

/** Fetch bounded API metadata and reduce it to the tag and an asset lookup. */
export async function fetchLatestReleaseViaApi(
  repo: string,
  apiBaseUrl = GITHUB_API_BASE_URL,
): Promise<GithubRelease> {
  const res = await httpFetch(`${apiBaseUrl}/repos/${repo}/releases/latest`, {
    headers: githubHeaders("json"),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpStatusError(
      res.status,
      formatGitHubApiError(res.status, repo, "releases/latest"),
    );
  }
  return validateReleaseMetadata(
    repo,
    JSON.parse(await readHttpTextBounded(res, MAX_GITHUB_METADATA_BYTES, "GitHub metadata")),
  );
}

/** Release metadata for a specific tag via the REST API. */
export async function fetchReleaseByTagViaApi(
  repo: string,
  normalizedTag: string,
): Promise<GithubRelease> {
  const res = await httpFetch(
    `https://api.github.com/repos/${repo}/releases/tags/${normalizedTag}`,
    {
      headers: githubHeaders("json"),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const message =
      res.status === 404
        ? `Release not found: ${normalizedTag}`
        : formatGitHubApiError(res.status, repo, `releases/tags/${normalizedTag}`);
    throw new HttpStatusError(res.status, message);
  }
  return validateReleaseMetadata(
    repo,
    JSON.parse(await readHttpTextBounded(res, MAX_GITHUB_METADATA_BYTES, "GitHub metadata")),
  );
}

/** Discover the tag without synthesizing assets; retain real metadata only on API fallback. */
export async function fetchLatestRelease(
  repo: string,
  deps = { resolveLatestReleaseTag, fetchLatestReleaseViaApi },
): Promise<GithubRelease> {
  try {
    return { tag: ensureReleaseTag(await deps.resolveLatestReleaseTag(repo)) };
  } catch (browserErr) {
    try {
      return await deps.fetchLatestReleaseViaApi(repo);
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

export function normalizeTagVersion(tag: string): string {
  return tag.replace(/^v/i, "");
}

export type GithubReachability = {
  ok: boolean;
  status?: number;
  remaining?: number;
  authenticated: boolean;
};

/**
 * Probe the GitHub API with this client's headers — including Authorization when
 * GITHUB_TOKEN/GH_TOKEN is set, which is what makes the reported rate limit the one
 * MiniCPA actually gets. Transport errors propagate; the caller reports them.
 * `apiBaseUrl` is overridable for tests only.
 */
export async function checkGithubReachability(
  apiBaseUrl = GITHUB_API_BASE_URL,
  timeoutMs = 3000,
): Promise<GithubReachability> {
  // Same predicate githubHeaders() uses, so a blank token never reads as authenticated.
  const authenticated = githubAuthToken() !== undefined;
  const res = await httpFetch(
    `${apiBaseUrl}/rate_limit`,
    {
      headers: githubHeaders("json"),
      signal: AbortSignal.timeout(timeoutMs),
    },
    { retries: 0 },
  );
  const result: GithubReachability = { ok: res.ok, status: res.status, authenticated };
  if (!res.ok) {
    try {
      await res.body?.cancel();
    } catch {
      /* ignore cancellation errors */
    }
    return result;
  }
  try {
    const body = JSON.parse(
      await readHttpTextBounded(res, MAX_GITHUB_METADATA_BYTES, "GitHub rate limit"),
    ) as { resources?: { core?: { remaining?: unknown } } };
    const remaining = body?.resources?.core?.remaining;
    if (typeof remaining === "number" && Number.isFinite(remaining)) {
      result.remaining = remaining;
    }
  } catch {
    /* rate_limit body is diagnostics only; reachability already established */
  }
  return result;
}
