export const DEFAULT_API_URL = "http://127.0.0.1:8317";

const INVALID_API_URL =
  "--api-url / MINICPA_API_URL must be an absolute HTTP(S) base URL without credentials, query or fragment";

export function apiBaseUrl(): string {
  let url: URL;
  try {
    url = new URL(process.env.MINICPA_API_URL?.trim() || DEFAULT_API_URL);
  } catch {
    // Do not include raw input: a mistaken URL may contain a password or token.
    throw new Error(INVALID_API_URL);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(INVALID_API_URL);
  }
  return url.href.replace(/\/+$/, "");
}
