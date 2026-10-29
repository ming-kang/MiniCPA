import { Agent, fetch as undiciFetch } from "undici";
import { apiBaseUrl } from "../api-url.js";
import { sleep } from "../util.js";

export { apiBaseUrl };

/** Public panel route; no knowledge of CLIProxyAPI's configuration schema. */
const PANEL_PATH = "/management.html";
const PROBE_REQUEST_TIMEOUT_MS = 2000;
const PROBE_PASS_INTERVAL_MS = 300;

/**
 * Direct CPA readiness probes bypass environment proxies. The isolated
 * dispatcher accepts self-signed CPA certificates; download clients retain
 * normal certificate verification.
 */
const loopbackDispatcher = new Agent({
  connect: {
    rejectUnauthorized: false,
  },
});

function isReadyStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304 || status === 401 || status === 403;
}

export async function waitForHttpOk(url: string, timeoutMs = 8000): Promise<boolean> {
  return (await waitForFirstHttpOk([url], timeoutMs)) !== undefined;
}

export async function waitForAnyHttpOk(urls: string[], timeoutMs = 8000): Promise<boolean> {
  return (await waitForFirstHttpOk(urls, timeoutMs)) !== undefined;
}

/** Probe endpoints under one total deadline, never reading response bodies. */
export async function waitForFirstHttpOk(
  urls: string[],
  timeoutMs = 8000,
): Promise<string | undefined> {
  const unique = [...new Set(urls.filter(Boolean))];
  if (unique.length === 0) return undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const url of unique) {
      const budget = deadline - Date.now();
      if (budget <= 0) break;
      try {
        const res = await undiciFetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(Math.max(1, Math.min(PROBE_REQUEST_TIMEOUT_MS, budget))),
          dispatcher: loopbackDispatcher,
        });
        await res.body?.cancel().catch(() => {});
        if (isReadyStatus(res.status)) return url;
      } catch {
        /* try next URL */
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(PROBE_PASS_INTERVAL_MS, remaining));
  }
  return undefined;
}

export function managementUrl(): string {
  return `${apiBaseUrl()}${PANEL_PATH}`;
}

/** Prefer the API root without loading or validating CLIProxyAPI's config. */
export function readinessUrls(): string[] {
  const base = apiBaseUrl();
  return [`${base}/`, `${base}${PANEL_PATH}`];
}
