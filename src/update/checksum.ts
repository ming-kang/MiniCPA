import { httpFetch, HttpStatusError, readHttpTextBounded } from "../http.js";
import { githubHeaders, isApiAssetUrl } from "./github-client.js";

const API_TIMEOUT_MS = 30_000;
export const MAX_CHECKSUM_BYTES = 256 * 1024;

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

export async function fetchChecksums(url: string): Promise<Map<string, string>> {
  const res = await httpFetch(url, {
    headers: githubHeaders(isApiAssetUrl(url) ? "download" : "browser"),
    redirect: "follow",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpStatusError(
      res.status,
      `Failed to download checksums.txt (HTTP ${res.status}). Use --insecure to skip integrity check.`,
    );
  }
  const map = parseChecksumsText(
    await readHttpTextBounded(res, MAX_CHECKSUM_BYTES, "checksums.txt"),
  );
  if (map.size === 0) {
    throw new Error("checksums.txt is empty or unparseable (use --insecure to skip)");
  }
  return map;
}
