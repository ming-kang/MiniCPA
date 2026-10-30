import { NetworkError, formatNetworkError, hasProxyEnvConfigured } from "./network-error.js";
export { NetworkError, formatNetworkError, hasProxyEnvConfigured } from "./network-error.js";
import {
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from "undici";
import { formatBytes, sleep } from "./util.js";

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

// undici EnvHttpProxyAgent ignores ALL_PROXY; ProxyAgent speaks HTTP CONNECT (no socks).
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
    // Drop previous agent so active in-flight requests can finish without abrupt closure.
    sharedProxyAgent = createProxyAgent();
    sharedProxySignature = signature;
  }
  return sharedProxyAgent;
}

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
    if (parsed.search) parsed.search = "?***";
    if (parsed.hash) parsed.hash = "#***";
    return parsed.toString();
  } catch {
    return "(invalid proxy URL)";
  }
}

export type HttpFetchInit = UndiciRequestInit;

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

export async function readHttpTextBounded(
  response: Pick<UndiciResponse, "body">,
  maxBytes: number,
  label: string,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes)
        throw new RangeError(`${label} exceeds the ${formatBytes(maxBytes)} size limit`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export type HttpRetryOptions = {
  retries?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
};

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function isAbortLikeError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function isRetryableNetworkError(err: unknown): boolean {
  if (isAbortLikeError(err)) return false;
  for (let current = err; current instanceof Error; current = current.cause) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  }
  return false;
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

export async function httpFetch(
  input: string | URL,
  init?: HttpFetchInit,
  retry?: HttpRetryOptions,
): Promise<UndiciResponse> {
  const url = typeof input === "string" ? input : input.toString();
  const retries = retry?.retries ?? 3;
  const minDelayMs = retry?.minDelayMs ?? 400;
  const maxDelayMs = retry?.maxDelayMs ?? 8_000;

  for (let attempt = 0; ; attempt++) {
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
      if (attempt >= retries || !isRetryableNetworkError(err)) {
        throw new NetworkError(formatNetworkError(err, url), { cause: err, url });
      }
      await sleep(retryDelayMs(attempt, minDelayMs, maxDelayMs));
    }
  }
}
