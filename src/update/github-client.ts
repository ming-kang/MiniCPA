import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { formatNetworkError, httpFetch, NetworkError } from "../http.js";
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

const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;
/** Abort a download that has received no bytes for this long (well under the total budget). */
const DOWNLOAD_STALL_MS = 60_000;
const DOWNLOAD_STALL_CHECK_MS = 5_000;
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

/** Hosts MiniCPA will fetch release assets / checksums / panels from. */
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

/** Loopback http(s) URLs used by offline unit-test fixtures only. */
function isLoopbackDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function assertUsableDownloadUrl(url: string, label: string): void {
  if (isAllowedGithubDownloadUrl(url) || isLoopbackDownloadUrl(url)) return;
  throw new Error(`Refusing download URL with untrusted host for ${label}: ${url}`);
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
  // Unit-test fixtures inject loopback servers; production paths never reach here
  // with a non-GitHub host because validateReleaseMetadata rejects them first.
  if (browser) {
    assertUsableDownloadUrl(browser, asset.name || "asset");
    return browser;
  }
  throw new Error(`No usable download URL for asset ${asset.name || "(unnamed)"}`);
}

function isApiAssetUrl(url: string): boolean {
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

function validateReleaseMetadata(repo: string, release: unknown): GhRelease {
  // Narrow before touching any field: a 200 with `{}`, `[]` or null must produce
  // this message, not a TypeError from deep inside a helper.
  if (
    release === null ||
    typeof release !== "object" ||
    Array.isArray(release) ||
    typeof (release as { tag_name?: unknown }).tag_name !== "string"
  ) {
    throw new Error(`GitHub returned invalid release metadata for ${repo}`);
  }
  const candidate = release as GhRelease;
  if (!isSafeReleaseTag(candidate.tag_name) || !Array.isArray(candidate.assets)) {
    throw new Error(`GitHub returned invalid release metadata for ${repo}`);
  }
  for (const asset of candidate.assets) {
    if (
      !asset ||
      typeof asset.name !== "string" ||
      typeof asset.browser_download_url !== "string"
    ) {
      throw new Error(`GitHub returned an invalid release asset for ${repo}`);
    }
    const browserUrl = asset.browser_download_url.trim();
    if (browserUrl && !isAllowedGithubDownloadUrl(browserUrl)) {
      throw new Error(`GitHub returned an untrusted download URL for ${repo} asset ${asset.name}`);
    }
    if (
      typeof asset.url === "string" &&
      asset.url.trim() &&
      !isAllowedGithubDownloadUrl(asset.url)
    ) {
      throw new Error(`GitHub returned an untrusted asset API URL for ${repo} asset ${asset.name}`);
    }
  }
  return candidate;
}

/**
 * Fetch full latest-release metadata via the REST API, including GitHub asset digests.
 * `apiBaseUrl` is overridable for tests only.
 */
export async function fetchLatestReleaseViaApi(
  repo: string,
  apiBaseUrl = GITHUB_API_BASE_URL,
): Promise<GhRelease> {
  const res = await httpFetch(`${apiBaseUrl}/repos/${repo}/releases/latest`, {
    headers: githubHeaders("json"),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(formatGitHubApiError(res.status, repo, "releases/latest"));
  }
  return validateReleaseMetadata(repo, (await res.json()) as unknown);
}

/** Release metadata for a specific tag via the REST API. */
export async function fetchReleaseByTagViaApi(
  repo: string,
  normalizedTag: string,
): Promise<GhRelease> {
  const res = await httpFetch(
    `https://api.github.com/repos/${repo}/releases/tags/${normalizedTag}`,
    {
      headers: githubHeaders("json"),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Release not found: ${normalizedTag}`);
    throw new Error(formatGitHubApiError(res.status, repo, `releases/tags/${normalizedTag}`));
  }
  return validateReleaseMetadata(repo, (await res.json()) as unknown);
}

/**
 * Latest release metadata. Prefers github.com redirect + synthetic browser asset URLs
 * (avoids REST rate limits). Falls back to the GitHub REST API when browser discovery fails.
 * `assetNamesForTag` supplies the asset names to synthesize for a resolved tag.
 */
export async function fetchLatestRelease(
  repo: string,
  assetNamesForTag: (tag: string) => string[],
): Promise<GhRelease> {
  try {
    const tag = await resolveLatestReleaseTag(repo);
    return synthesizePublicRelease(repo, tag, assetNamesForTag(tag));
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

export function repoFromPanelUrl(panelRepoUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(panelRepoUrl);
  } catch {
    throw new Error(`Unsupported panel repository URL: ${panelRepoUrl}`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
    throw new Error(`Unsupported panel repository URL: ${panelRepoUrl}`);
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const owner = parts[0];
  const repository = parts[1]?.replace(/\.git$/i, "");
  const safePart = /^[A-Za-z0-9_.-]+$/;
  if (!owner || !repository || !safePart.test(owner) || !safePart.test(repository)) {
    throw new Error(`Unsupported panel repository URL: ${panelRepoUrl}`);
  }
  return `${owner}/${repository}`;
}

export function normalizeTagVersion(tag: string): string {
  return tag.replace(/^v/i, "");
}

export type DownloadOptions = {
  /** Shown in progress events / error messages. */
  label?: string;
  timeoutMs?: number;
  /** Abort when no byte arrives for this long (default 60s, well under timeoutMs). */
  stallTimeoutMs?: number;
  /** Refuse a response larger than this many bytes (both declared and streamed). */
  maxBytes?: number;
  /** Called per chunk (done: false) and once after completion (done: true). */
  onProgress?: (event: {
    label: string;
    receivedBytes: number;
    totalBytes: number;
    done: boolean;
  }) => void;
};

/** Stream download to disk with optional progress callback. Honors proxy env via httpFetch. */
export async function downloadToFile(
  url: string,
  dest: string,
  options?: DownloadOptions,
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const label = options?.label ?? path.basename(dest);
  const useApiAsset = isApiAssetUrl(url);

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

  const contentLength = Number(res.headers.get("content-length") || 0);
  const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
  const maxBytes = options?.maxBytes;
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) {
    throw new Error(`Invalid maximum download size for ${label}`);
  }
  if (maxBytes !== undefined && total > maxBytes) {
    try {
      await res.body.cancel();
    } catch {
      /* ignore cancellation failure */
    }
    throw new Error(`Download exceeds ${formatBytes(maxBytes)} limit: ${label}`);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let received = 0;
  const onProgress = options?.onProgress;

  const nodeBody = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  let lastChunkAt = Date.now();
  const limiter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback): void {
      lastChunkAt = Date.now();
      const n = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      received += n;
      if (maxBytes !== undefined && received > maxBytes) {
        callback(new Error(`Download exceeds ${formatBytes(maxBytes)} limit: ${label}`));
        return;
      }
      onProgress?.({ label, receivedBytes: received, totalBytes: total, done: false });
      callback(null, chunk);
    },
  });

  // The total AbortSignal.timeout above bounds the whole transfer; this watchdog
  // fails fast on a connection that opened and then went silent.
  const stallMs = options?.stallTimeoutMs ?? DOWNLOAD_STALL_MS;
  const stallSeconds = Math.max(1, Math.round(stallMs / 1_000));
  const stallTimer = setInterval(
    () => {
      if (Date.now() - lastChunkAt >= stallMs) {
        nodeBody.destroy(new Error(`Download stalled (no data for ${stallSeconds}s): ${label}`));
      }
    },
    Math.min(DOWNLOAD_STALL_CHECK_MS, stallMs),
  );
  stallTimer.unref?.();

  try {
    await pipeline(nodeBody, limiter, fs.createWriteStream(dest));
  } catch (err) {
    try {
      fs.unlinkSync(dest);
    } catch {
      /* ignore */
    }
    // The size limiter's own error is a policy decision, not a transport failure:
    // callers match on its text, so it must pass through untouched.
    if (isSizeLimitError(err)) throw err;
    throw new NetworkError(formatNetworkError(err, url), { cause: err, url });
  } finally {
    clearInterval(stallTimer);
  }

  onProgress?.({ label, receivedBytes: received, totalBytes: total, done: true });
  if (received === 0) {
    try {
      fs.unlinkSync(dest);
    } catch {
      /* ignore */
    }
    throw new Error(`Download failed (empty file): ${label}`);
  }
}

function isSizeLimitError(err: unknown): boolean {
  return err instanceof Error && /^Download exceeds .* limit: /.test(err.message);
}

/** Parse GitHub checksums.txt body into map of filename → sha256. */
export function parseChecksumsText(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+(.+)$/i);
    // sha256sum -b writes "<hash> *<file>": the marker is binary mode, not the name.
    if (m) map.set(m[2]!.trim().replace(/^\*/, ""), m[1]!.toLowerCase());
  }
  return map;
}

export function parseGithubDigest(digest: string | undefined): string | undefined {
  // API payloads are untrusted: a non-string digest must not throw on .trim().
  if (!digest || typeof digest !== "string") return undefined;
  const m = digest.trim().match(/^sha256:([a-f0-9]{64})$/i);
  return m?.[1]?.toLowerCase();
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
): Promise<GithubReachability> {
  // Same predicate githubHeaders() uses, so a blank token never reads as authenticated.
  const authenticated = githubAuthToken() !== undefined;
  const res = await httpFetch(
    `${apiBaseUrl}/rate_limit`,
    {
      headers: githubHeaders("json"),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
    { retries: 1, minDelayMs: 200, maxDelayMs: 1_000 },
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
    const body = (await res.json()) as { resources?: { core?: { remaining?: unknown } } };
    const remaining = body?.resources?.core?.remaining;
    if (typeof remaining === "number" && Number.isFinite(remaining)) {
      result.remaining = remaining;
    }
  } catch {
    /* rate_limit body is diagnostics only; reachability already established */
  }
  return result;
}

export async function fetchChecksums(
  release: GhRelease,
  repo: string,
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
