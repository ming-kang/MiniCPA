import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { formatBytes } from "../util.js";

export type GhRelease = {
  tag_name: string;
  name: string;
  published_at: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    digest?: string;
  }>;
};

const CPA_REPO = "router-for-me/CLIProxyAPI";
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 300_000;

function githubHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "MiniCPA",
  };
  if (json) headers.Accept = "application/vnd.github+json";
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function fetchLatestRelease(repo: string): Promise<GhRelease> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubHeaders(true),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${repo}`);
  }
  return (await res.json()) as GhRelease;
}

export async function fetchLatestCpaRelease(): Promise<GhRelease> {
  return fetchLatestRelease(CPA_REPO);
}

export async function fetchCpaReleaseByTag(tag: string): Promise<GhRelease> {
  const normalized = tag.startsWith("v") ? tag : `v${tag}`;
  const res = await fetch(
    `https://api.github.com/repos/${CPA_REPO}/releases/tags/${normalized}`,
    {
      headers: githubHeaders(true),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Release not found: ${normalized}`);
  return (await res.json()) as GhRelease;
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
};

/** Stream download to disk with optional progress on stderr. */
export async function downloadToFile(
  url: string,
  dest: string,
  options?: DownloadOptions,
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const label = options?.label ?? path.basename(dest);

  const res = await fetch(url, {
    headers: githubHeaders(false),
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  if (!res.body) throw new Error(`Download failed (empty body): ${url}`);

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
  } catch (err) {
    try {
      fs.unlinkSync(dest);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function pickReleaseAsset(
  release: GhRelease,
  platform: NodeJS.Platform,
  arch: string,
): { assetName: string; url: string } {
  const version = normalizeTagVersion(release.tag_name);
  const candidates: string[] = [];

  if (platform === "win32") {
    if (arch === "arm64") candidates.push(`CLIProxyAPI_${version}_windows_arm64.zip`);
    candidates.push(`CLIProxyAPI_${version}_windows_amd64.zip`);
  } else if (platform === "darwin") {
    if (arch === "arm64") candidates.push(`CLIProxyAPI_${version}_darwin_aarch64.tar.gz`);
    candidates.push(`CLIProxyAPI_${version}_darwin_amd64.tar.gz`);
  } else {
    if (arch === "arm64") candidates.push(`CLIProxyAPI_${version}_linux_arm64.tar.gz`);
    candidates.push(`CLIProxyAPI_${version}_linux_amd64.tar.gz`);
    candidates.push(`CLIProxyAPI_${version}_linux_amd64_portable.tar.gz`);
  }

  for (const name of candidates) {
    const asset = release.assets.find((a) => a.name === name);
    if (asset) return { assetName: asset.name, url: asset.browser_download_url };
  }

  throw new Error(
    `No release asset for ${platform}/${arch}. Tried: ${candidates.join(", ")}`,
  );
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

export async function fetchChecksums(release: GhRelease): Promise<Map<string, string>> {
  const asset = release.assets.find((a) => a.name === "checksums.txt");
  if (!asset) {
    throw new Error(
      `Release ${release.tag_name} has no checksums.txt (use --insecure to skip integrity check)`,
    );
  }

  const res = await fetch(asset.browser_download_url, {
    headers: githubHeaders(false),
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
