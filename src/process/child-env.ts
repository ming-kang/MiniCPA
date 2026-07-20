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

/**
 * Environment for cli-proxy-api / tui / version-probe children: copy of process.env
 * without MiniCPA update credentials.
 */
export function buildCpaChildEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...sourceEnv };
  for (const key of STRIPPED_ENV_KEYS) {
    delete childEnv[key];
  }
  return childEnv;
}

export function strippedEnvKeys(): readonly string[] {
  return STRIPPED_ENV_KEYS;
}
