import { httpFetch } from "../http.js";
import {
  browserReleaseAssetUrl,
  githubHeaders,
  isApiAssetUrl,
  releaseAssetDownloadUrl,
  type GhRelease,
} from "./github-client.js";

const API_TIMEOUT_MS = 30_000;

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
