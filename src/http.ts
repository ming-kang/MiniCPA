import { NetworkError, formatNetworkError, hasProxyEnvConfigured } from "./network-error.js";
export { NetworkError, formatNetworkError, hasProxyEnvConfigured } from "./network-error.js";
import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from "undici";
import { sleep } from "./util.js";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

let sharedProxyAgent: EnvHttpProxyAgent | undefined;
let sharedProxySignature: string | undefined;

function proxyEnvSignature(env: NodeJS.ProcessEnv = process.env): string {
  return PROXY_ENV_KEYS.map((key) => `${key}=${env[key] ?? ""}`).join("\n");
}

/**
 * ALL_PROXY value only when undici can actually use it: its ProxyAgent speaks
 * HTTP CONNECT, so socks5:// (and anything else) cannot be honored.
 */
function applicableAllProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.ALL_PROXY ?? env.all_proxy;
  if (!value) return undefined;
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function createProxyAgent(env: NodeJS.ProcessEnv = process.env): EnvHttpProxyAgent {
  const allProxy = applicableAllProxy(env);
  // undici's EnvHttpProxyAgent reads HTTP(S)_PROXY / NO_PROXY (any case) itself but
  // ignores ALL_PROXY entirely, so fill it in as the fallback for both schemes.
  if (!allProxy) return new EnvHttpProxyAgent();
  return new EnvHttpProxyAgent({
    httpProxy: env.http_proxy ?? env.HTTP_PROXY ?? allProxy,
    httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? allProxy,
  });
}

function getProxyAgent(): EnvHttpProxyAgent {
  const signature = proxyEnvSignature();
  if (!sharedProxyAgent || sharedProxySignature !== signature) {
    // One agent per distinct proxy environment; the previous one is dropped
    // rather than destroyed so in-flight requests on it still complete.
    sharedProxyAgent = createProxyAgent();
    sharedProxySignature = signature;
  }
  return sharedProxyAgent;
}

/** Human-readable summary for doctor / DEBUG (values redacted). */
export function describeProxyEnv(env: NodeJS.ProcessEnv = process.env): string {
  if (!hasProxyEnvConfigured(env)) return "none";
  const parts: string[] = [];
  for (const key of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ] as const) {
    const value = env[key];
    if (!value) continue;
    // An ALL_PROXY that undici cannot dial (e.g. socks5://) is reported, but
    // must not read as if it were in effect.
    const note =
      (key === "ALL_PROXY" || key === "all_proxy") && !applicableAllProxy(env)
        ? " (scheme not applied)"
        : "";
    parts.push(`${key}=${redactProxyUrl(value)}${note}`);
  }
  const noProxy = env.NO_PROXY || env.no_proxy;
  if (noProxy) {
    parts.push(`NO_PROXY=(set, ${noProxy.split(/[,\s]+/).filter(Boolean).length} entries)`);
  }
  return parts.join(" ");
}

/** Download transport summary; HTTPS falls back to HTTP just as EnvHttpProxyAgent does. */
export function describeDownloadRoute(env: NodeJS.ProcessEnv = process.env): string {
  const allProxy = applicableAllProxy(env);
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? allProxy;
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY ?? allProxy;
  const selected = httpsProxy || httpProxy;
  if (!selected) {
    return env.ALL_PROXY || env.all_proxy ? "Direct · ALL_PROXY scheme not supported" : "Direct";
  }
  const noProxy = env.no_proxy ?? env.NO_PROXY ?? "";
  if (noProxy === "*") return "Direct · NO_PROXY=*";
  const url = redactProxyUrl(selected).replace(/\/$/, "");
  return `Environment Proxy · ${url}${noProxy ? " · NO_PROXY rules apply" : ""}`;
}

export function redactProxyUrl(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? "***" : "";
      parsed.password = parsed.password ? "***" : "";
    }
    // Proxy URLs should not normally carry a query or fragment; redact both in
    // diagnostics because they may contain bearer tokens or credentials.
    if (parsed.search) parsed.search = "?***";
    if (parsed.hash) parsed.hash = "#***";
    return parsed.toString();
  } catch {
    return "(invalid proxy URL)";
  }
}

export type HttpFetchInit = UndiciRequestInit;

export type HttpRetryOptions = {
  /** Extra attempts after the first try (default 3 → up to 4 total). */
  retries?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
};

/** HTTP statuses worth retrying for GitHub / CDN flakiness. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function isAbortLikeError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /\bAbortError\b|\bTimeoutError\b|aborted|The operation was aborted/i.test(message);
}

/** Transient transport failures (not 4xx application errors). */
export function isRetryableNetworkError(err: unknown): boolean {
  if (isAbortLikeError(err)) {
    // Hard aborts do not retry; undici connect timeouts still should.
    const message = formatNetworkError(err);
    if (/UND_ERR_CONNECT_TIMEOUT|Connect Timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(message)) {
      return true;
    }
    return false;
  }
  const message = formatNetworkError(err);
  return /timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|UND_ERR|fetch failed|socket|network/i.test(
    message,
  );
}

export function retryDelayMs(
  attempt: number,
  minDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
  const jitter = Math.floor(random() * Math.min(250, Math.max(1, base * 0.2)));
  return base + jitter;
}

/**
 * HTTP fetch that honors shell proxy env vars via undici EnvHttpProxyAgent
 * (HTTP_PROXY, HTTPS_PROXY, NO_PROXY — upper or lower case, plus ALL_PROXY
 * when it is an http:/https: URL).
 *
 * Retries transient network failures and 408/425/429/5xx by default.
 * Pass `{ retries: 0 }` to disable.
 */
export async function httpFetch(
  input: string | URL,
  init?: HttpFetchInit,
  retry?: HttpRetryOptions,
): Promise<UndiciResponse> {
  const url = typeof input === "string" ? input : input.toString();
  const retries = retry?.retries ?? 3;
  const minDelayMs = retry?.minDelayMs ?? 400;
  const maxDelayMs = retry?.maxDelayMs ?? 8_000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await undiciFetch(input, {
        ...init,
        dispatcher: getProxyAgent(),
      });
      if (attempt < retries && isRetryableHttpStatus(res.status)) {
        // Cancel instead of draining: a misbehaving proxy can attach an
        // arbitrarily large body to a retryable 5xx.
        try {
          await res.body?.cancel();
        } catch {
          /* ignore cancellation errors */
        }
        await sleep(retryDelayMs(attempt, minDelayMs, maxDelayMs));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt >= retries || !isRetryableNetworkError(err)) {
        throw new NetworkError(formatNetworkError(err, url), { cause: err, url });
      }
      await sleep(retryDelayMs(attempt, minDelayMs, maxDelayMs));
    }
  }
  throw new NetworkError(formatNetworkError(lastError, url), { cause: lastError, url });
}
