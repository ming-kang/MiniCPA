import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STRIPPED_ENV_KEYS, buildCredentialSafeChildEnv } from "./child-env.js";

/** `GITHUB_TOKEN` -> `GiThUb_ToKeN`, so a case-folding regression is caught. */
function mixedCase(key: string): string {
  return [...key].map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase())).join("");
}

/**
 * Independent anchor: the stripping assertions below are driven from
 * STRIPPED_ENV_KEYS, so they cannot notice a key being deleted from it. These
 * are the MiniCPA update credentials that must never reach a CPA child.
 */
const REQUIRED_STRIPPED_KEYS = [
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
];

describe("STRIPPED_ENV_KEYS", () => {
  it("still covers every credential key MiniCPA is known to read", () => {
    for (const key of REQUIRED_STRIPPED_KEYS) {
      assert.ok(
        (STRIPPED_ENV_KEYS as readonly string[]).includes(key),
        `${key} was dropped from STRIPPED_ENV_KEYS`,
      );
    }
  });

  it("is uppercase-normalized so the case-insensitive lookup works", () => {
    for (const key of STRIPPED_ENV_KEYS) {
      assert.equal(key, key.toUpperCase());
    }
  });
});

describe("buildCredentialSafeChildEnv", () => {
  it("strips every key in STRIPPED_ENV_KEYS in every case while keeping unrelated values", () => {
    const sourceEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      CPA_HOME: "/data/cpa",
      "npm_config_//registry.npmjs.org/:_authToken": "secret-dynamic-token",
      npm_config_custom_auth: "secret-dynamic-auth",
    };
    for (const key of STRIPPED_ENV_KEYS) {
      for (const spelling of [key, key.toLowerCase(), mixedCase(key)]) {
        sourceEnv[spelling] = `secret-${key}`;
      }
    }

    const child = buildCredentialSafeChildEnv(sourceEnv);

    assert.ok(STRIPPED_ENV_KEYS.length > 0);
    for (const key of STRIPPED_ENV_KEYS) {
      for (const spelling of [key, key.toLowerCase(), mixedCase(key)]) {
        assert.equal(child[spelling], undefined, `${spelling} leaked into the child env`);
      }
    }
    assert.equal(child.PATH, "/usr/bin");
    assert.equal(child.HOME, "/home/user");
    assert.equal(child.CPA_HOME, "/data/cpa");
    assert.equal(child["npm_config_//registry.npmjs.org/:_authToken"], undefined);
    assert.equal(child.npm_config_custom_auth, undefined);
    for (const value of Object.values(child)) {
      assert.doesNotMatch(String(value), /^secret-/);
    }
  });

  it("does not mutate the source environment", () => {
    const sourceEnv: NodeJS.ProcessEnv = { GITHUB_TOKEN: "secret-gh", PATH: "/usr/bin" };
    buildCredentialSafeChildEnv(sourceEnv);
    assert.equal(sourceEnv.GITHUB_TOKEN, "secret-gh");
  });
});
