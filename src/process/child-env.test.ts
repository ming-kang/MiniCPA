import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCpaChildEnv } from "./child-env.js";

describe("buildCpaChildEnv", () => {
  it("strips known tokens in every case while keeping unrelated values", () => {
    const child = buildCpaChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      GITHUB_TOKEN: "secret-gh",
      github_token: "secret-gh-lower",
      Gh_ToKeN: "secret-gh-mixed",
      GH_TOKEN: "secret-gh2",
      gh_enterprise_token: "secret-ent",
      GITHUB_PAT: "secret-pat",
      npm_token: "secret-npm",
      NPM_AUTH_TOKEN: "secret-npm-auth",
      node_auth_token: "secret-node",
      CPA_HOME: "/data/cpa",
    });
    assert.equal(child.PATH, "/usr/bin");
    assert.equal(child.HOME, "/home/user");
    assert.equal(child.CPA_HOME, "/data/cpa");
    for (const value of Object.values(child)) {
      assert.doesNotMatch(String(value), /^secret-/);
    }
  });
});
