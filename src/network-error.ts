/**
 * Network failure whose message was already enriched by formatNetworkError
 * (cause chain, host, proxy hint). The CLI error formatter passes it through.
 */
export class NetworkError extends Error {
  readonly url?: string;

  constructor(message: string, options?: { cause?: unknown; url?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "NetworkError";
    this.url = options?.url;
  }
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
