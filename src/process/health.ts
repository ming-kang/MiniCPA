import { Agent, fetch as undiciFetch } from "undici";
import { apiBaseUrl } from "../api-url.js";
import { sleep } from "../util.js";

export { apiBaseUrl };

const PANEL_PATH = "/management.html";
const PROBE_REQUEST_TIMEOUT_MS = 2000;
const PROBE_PASS_INTERVAL_MS = 300;

// Probes never use environment proxies. Only loopback targets, where CPA typically
// serves a self-signed certificate, skip certificate verification; a remote --api-url
// (for example behind a reverse proxy) must present a valid certificate.
const loopbackDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const remoteDispatcher = new Agent();

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === "[::1]"
  );
}

function probeDispatcher(url: string): Agent {
  try {
    return isLoopbackHostname(new URL(url).hostname) ? loopbackDispatcher : remoteDispatcher;
  } catch {
    return remoteDispatcher;
  }
}

function isReadyStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304 || status === 401 || status === 403;
}

export async function waitForAnyHttpOk(urls: string[], timeoutMs = 8000): Promise<boolean> {
  return (await waitForFirstHttpOk(urls, timeoutMs)) !== undefined;
}

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
          dispatcher: probeDispatcher(url),
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

export function readinessUrls(): string[] {
  const base = apiBaseUrl();
  return [`${base}/`, `${base}${PANEL_PATH}`];
}
