import { getListenAddress, readCpaConfig } from "../config-yaml.js";
import { cpaLayout } from "../paths.js";
import { sleep } from "../util.js";

/**
 * Map wildcard listen addresses to a loopback host for local HTTP probes.
 * Concrete IPv6 literals are returned with brackets for URL use.
 */
export function normalizeListenHost(host: string): string {
  const trimmed = host.trim();
  const lower = trimmed.toLowerCase();
  if (
    lower === "0.0.0.0" ||
    lower === "::" ||
    lower === "[::]" ||
    lower === "::0" ||
    lower === "[::0]"
  ) {
    return "127.0.0.1";
  }
  // IPv6 literal without brackets → bracket for URL host part
  if (trimmed.includes(":") && !trimmed.startsWith("[")) {
    return `[${trimmed}]`;
  }
  return trimmed;
}

function formatHttpBase(host: string, port: number): string {
  const normalizedHost = normalizeListenHost(host);
  return `http://${normalizedHost}:${port}`;
}

function isReadyStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304 || status === 401 || status === 403;
}

export async function waitForHttpOk(url: string, timeoutMs = 8000): Promise<boolean> {
  return waitForAnyHttpOk([url], timeoutMs);
}

/** Probe several URLs until one returns a "server up" status (panel may 404). */
export async function waitForAnyHttpOk(urls: string[], timeoutMs = 8000): Promise<boolean> {
  const unique = [...new Set(urls.filter(Boolean))];
  if (unique.length === 0) return false;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const url of unique) {
      try {
        // Local loopback probe — use global fetch so HTTP(S)_PROXY is not applied.
        const res = await fetch(url, {
          method: "GET",
          signal: AbortSignal.timeout(2000),
        });
        if (isReadyStatus(res.status)) {
          return true;
        }
      } catch {
        /* try next URL */
      }
    }
    await sleep(300);
  }
  return false;
}

export function managementUrl(home: string): string {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  const { host, port } = getListenAddress(cfg);
  return `${formatHttpBase(host, port)}/management.html`;
}

export function apiBaseUrl(home: string): string {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  const { host, port } = getListenAddress(cfg);
  return formatHttpBase(host, port);
}

/** Prefer panel URL, then root — works for binary-only installs without management.html. */
export function readinessUrls(home: string): string[] {
  const base = apiBaseUrl(home);
  return [`${base}/management.html`, `${base}/`, base];
}
