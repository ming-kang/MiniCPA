export class NetworkError extends Error {
  readonly url?: string;

  constructor(message: string, options?: { cause?: unknown; url?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "NetworkError";
    this.url = options?.url;
  }
}

/** Proxy URL variables in both cases; NO_PROXY only qualifies them. */
export const PROXY_URL_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

export function hasProxyEnvConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return PROXY_URL_ENV_KEYS.some((key) => Boolean(env[key]));
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

const NETWORK_ERROR_CODE =
  /^(?:UND_ERR_|ECONN|ETIMEDOUT$|ESOCKETTIMEDOUT$|EAI_AGAIN$|ENOTFOUND$|EHOSTUNREACH$|ENETUNREACH$|EPIPE$)/;

/**
 * True only for transport failures that escaped `httpFetch` wrapping (for example a
 * response body that breaks mid-read). Any other error with a `cause` — lock conflicts,
 * npm failures — keeps its own message.
 */
export function isNetworkFailure(err: unknown): boolean {
  return causeChain(err).some((item) => {
    if (!(item instanceof Error)) return false;
    const code = (item as NodeJS.ErrnoException).code;
    return (
      (typeof code === "string" && NETWORK_ERROR_CODE.test(code)) ||
      (item instanceof TypeError && item.message === "fetch failed")
    );
  });
}

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
