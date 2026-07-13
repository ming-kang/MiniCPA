import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from "undici";

/** Proxy-related env keys (PowerShell profile, bashrc, etc.). */
export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

let sharedProxyAgent: EnvHttpProxyAgent | undefined;

function getProxyAgent(): EnvHttpProxyAgent {
  if (!sharedProxyAgent) {
    // Reads HTTP(S)_PROXY / ALL_PROXY / NO_PROXY (any case) from process.env.
    sharedProxyAgent = new EnvHttpProxyAgent();
  }
  return sharedProxyAgent;
}

/** True when any outbound proxy URL is configured in the environment. */
export function hasProxyEnvConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.HTTP_PROXY ||
      env.HTTPS_PROXY ||
      env.ALL_PROXY ||
      env.http_proxy ||
      env.https_proxy ||
      env.all_proxy,
  );
}

/** Human-readable summary for doctor / DEBUG (values redacted). */
export function describeProxyEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (!hasProxyEnvConfigured(env)) return "none";
  const parts: string[] = [];
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] as const) {
    const value = env[key];
    if (!value) continue;
    parts.push(`${key}=${redactProxyUrl(value)}`);
  }
  const noProxy = env.NO_PROXY || env.no_proxy;
  if (noProxy) parts.push(`NO_PROXY=(set, ${noProxy.split(/[,\s]+/).filter(Boolean).length} entries)`);
  return parts.join(" ");
}

export function redactProxyUrl(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = parsed.password ? "***" : "";
    }
    return parsed.toString();
  } catch {
    return "(invalid proxy URL)";
  }
}

function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    if (current instanceof Error && "cause" in current) {
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return chain;
}

/**
 * Expand undici/Node "fetch failed" into something actionable
 * (timeout host, ECONNREFUSED, proxy hint).
 */
export function formatNetworkError(err: unknown, contextUrl?: string): string {
  const parts: string[] = [];
  for (const item of causeChain(err)) {
    if (item instanceof Error) {
      const withCode = item as Error & { code?: string; address?: string; port?: number };
      const code = withCode.code ? ` [${withCode.code}]` : "";
      parts.push(`${item.message}${code}`);
    } else if (item != null) {
      parts.push(String(item));
    }
  }
  let message = parts.filter(Boolean).join(" ← ") || "Network request failed";
  if (contextUrl) {
    try {
      const host = new URL(contextUrl).host;
      message = `${message} (${host})`;
    } catch {
      message = `${message} (${contextUrl})`;
    }
  }
  if (!hasProxyEnvConfigured() && /timeout|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(message)) {
    message +=
      "\nHint: set HTTPS_PROXY/HTTP_PROXY/ALL_PROXY in your shell profile if you need a proxy.";
  }
  return message;
}

export type HttpFetchInit = UndiciRequestInit;

/**
 * HTTP fetch that honors shell proxy env vars via undici EnvHttpProxyAgent
 * (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, NO_PROXY — upper or lower case).
 */
export async function httpFetch(
  input: string | URL,
  init?: HttpFetchInit,
): Promise<UndiciResponse> {
  const url = typeof input === "string" ? input : input.toString();
  try {
    return await undiciFetch(input, {
      ...init,
      dispatcher: getProxyAgent(),
    });
  } catch (err) {
    throw new Error(formatNetworkError(err, url), { cause: err });
  }
}
