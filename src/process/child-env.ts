/** Secrets used by MiniCPA for GitHub/npm — must not leak into CPA children. */
const STRIPPED_ENV_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_PAT",
  "GITHUB_ACCESS_TOKEN",
  "GH_PAT",
  "NPM_TOKEN",
  "NPM_AUTH_TOKEN",
  "NODE_AUTH_TOKEN",
] as const;

const STRIPPED_ENV_KEY_SET = new Set<string>(STRIPPED_ENV_KEYS);

/**
 * Environment for cli-proxy-api / tui / version-probe children: copy of process.env
 * without MiniCPA update credentials.
 */
export function buildCpaChildEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...sourceEnv };
  // Windows environment-variable names are case-insensitive. Filter every spelling
  // on every platform so a differently cased token can never reach a CPA child.
  for (const key of Object.keys(childEnv)) {
    if (STRIPPED_ENV_KEY_SET.has(key.toUpperCase())) {
      delete childEnv[key];
    }
  }
  return childEnv;
}
