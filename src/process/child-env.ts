/** Secrets used by MiniCPA for GitHub/npm — must not leak into CPA children. */
export const STRIPPED_ENV_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "GITHUB_ACCESS_TOKEN",
  "GH_PAT",
  "NPM_TOKEN",
  "NPM_AUTH_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_ID_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
] as const;

const STRIPPED_ENV_KEY_SET = new Set<string>(STRIPPED_ENV_KEYS);

/** Copy an environment while removing credentials that must never reach child processes. */
export function buildCredentialSafeChildEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...sourceEnv };
  // Windows environment-variable names are case-insensitive. Filter every spelling
  // on every platform so a differently cased token can never reach a child.
  for (const key of Object.keys(childEnv)) {
    const upper = key.toUpperCase();
    const lower = key.toLowerCase();
    const isNpmAuthConfig =
      lower.startsWith("npm_config_") &&
      (lower.includes("authtoken") || lower.includes("auth_token") || lower.endsWith("_auth"));
    if (STRIPPED_ENV_KEY_SET.has(upper) || isNpmAuthConfig) {
      delete childEnv[key];
    }
  }
  return childEnv;
}

/** Environment for cli-proxy-api / tui / version-probe children. */
export function buildCpaChildEnv(sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return buildCredentialSafeChildEnv(sourceEnv);
}
