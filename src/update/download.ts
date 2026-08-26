import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { formatNetworkError, httpFetch, NetworkError } from "../http.js";
import { formatBytes } from "../util.js";
import { githubHeaders, isApiAssetUrl } from "./github-client.js";

const DOWNLOAD_TIMEOUT_MS = 300_000;
/** Abort a download that has received no bytes for this long (well under the total budget). */
const DOWNLOAD_STALL_MS = 60_000;
const DOWNLOAD_STALL_CHECK_MS = 5_000;

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
