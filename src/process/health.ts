import { Agent, fetch as undiciFetch } from "undici";
import { getListenAddress, isTlsEnabled, readCpaConfig } from "../config-yaml.js";
import { cpaLayout } from "../paths.js";
import { sleep } from "../util.js";

/** Path of the remote-management panel, relative to the CPA HTTP base. */
const PANEL_PATH = "/management.html";

/** Longest a single probe request may wait, before the caller's deadline clamps it. */
const PROBE_REQUEST_TIMEOUT_MS = 2000;

/** Pause between probe passes, before the caller's deadline clamps it. */
const PROBE_PASS_INTERVAL_MS = 300;

/**
 * Direct dispatcher for loopback readiness probes: a plain undici Agent never
 * consults HTTP_PROXY/HTTPS_PROXY, unlike global fetch, which Node routes
 * through the environment proxy (including loopback) under NODE_USE_ENV_PROXY
 * or --use-env-proxy. Deliberately not httpFetch from ../http.js — that one
 * applies the proxy agent and retries, which is wrong for a local probe.
 *
 * Disables certificate verification strictly for local readiness probes so
 * self-signed certificates on loopback CPA HTTPS endpoints are accepted.
 */
const loopbackDispatcher = new Agent({
  connect: {
    rejectUnauthorized: false,
  },
});

export function isWildcardListenHost(host: string): boolean {
  const lower = host.trim().toLowerCase();
  return (
    lower === "0.0.0.0" ||
    lower === "::" ||
    lower === "[::]" ||
    lower === "::0" ||
    lower === "[::0]"
  );
}

/**
 * Map wildcard listen addresses to a loopback host for local HTTP probes.
 * Concrete IPv6 literals are returned with brackets for URL use.
 */
export function normalizeListenHost(host: string): string {
  const trimmed = host.trim();
  if (isWildcardListenHost(trimmed)) {
    return "127.0.0.1";
  }
  // IPv6 literal without brackets → bracket for URL host part
  if (trimmed.includes(":") && !trimmed.startsWith("[")) {
    return `[${trimmed}]`;
  }
  return trimmed;
}

function formatHttpBase(host: string, port: number, tls = false): string {
  const scheme = tls ? "https" : "http";
  const normalizedHost = normalizeListenHost(host);
  return `${scheme}://${normalizedHost}:${port}`;
}

function isReadyStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 304 || status === 401 || status === 403;
}

export async function waitForHttpOk(url: string, timeoutMs = 8000): Promise<boolean> {
  return waitForAnyHttpOk([url], timeoutMs);
}

/**
 * Probe several URLs until one returns a "server up" status (panel may 404).
 * Never runs past `timeoutMs`: every request timeout and inter-pass sleep is
 * clamped to the remaining budget, so N URLs cannot multiply the caller's wait.
 */
export async function waitForAnyHttpOk(urls: string[], timeoutMs = 8000): Promise<boolean> {
  const unique = [...new Set(urls.filter(Boolean))];
  if (unique.length === 0) return false;
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
        // Release the socket back to the dispatcher; a probe never reads a body.
        await res.body?.cancel().catch(() => {});
        if (isReadyStatus(res.status)) {
          return true;
        }
      } catch {
        /* try next URL */
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(PROBE_PASS_INTERVAL_MS, remaining));
  }
  return false;
}

/** Single source of truth for the configured CPA HTTP/HTTPS base (one config read). */
function resolveBase(home: string): string {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  const { host, port } = getListenAddress(cfg);
  return formatHttpBase(host, port, isTlsEnabled(cfg));
}

export function managementUrl(home: string): string {
  return `${resolveBase(home)}${PANEL_PATH}`;
}

export function apiBaseUrl(home: string): string {
  return resolveBase(home);
}

/** Prefer panel URL, then root — works for binary-only installs without management.html. */
export function readinessUrls(home: string): string[] {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  const { host, port } = getListenAddress(cfg);
  const tls = isTlsEnabled(cfg);
  const primaryBase = formatHttpBase(host, port, tls);
  const urls = [`${primaryBase}${PANEL_PATH}`, `${primaryBase}/`];

  if (isWildcardListenHost(host)) {
    const scheme = tls ? "https" : "http";
    const ipv6Base = `${scheme}://[::1]:${port}`;
    urls.push(`${ipv6Base}${PANEL_PATH}`, `${ipv6Base}/`);
  }

  return [...new Set(urls)];
}
