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

export async function waitForHttpOk(url: string, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok || res.status === 304 || res.status === 401 || res.status === 403) {
        // Any HTTP response from CPA means the server is up (panel may require auth).
        return true;
      }
    } catch {
      /* retry */
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
