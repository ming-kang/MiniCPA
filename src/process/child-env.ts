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

export function buildCredentialSafeChildEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...sourceEnv };
  // Filter all case variants (Windows env vars are case-insensitive).
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
