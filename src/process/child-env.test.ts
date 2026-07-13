import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCpaChildEnv, strippedEnvKeys } from "./child-env.js";

describe("buildCpaChildEnv", () => {
  it("strips known tokens and keeps PATH", () => {
    const child = buildCpaChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/user",
      GITHUB_TOKEN: "secret-gh",
      GH_TOKEN: "secret-gh2",
      NPM_TOKEN: "secret-npm",
      NODE_AUTH_TOKEN: "secret-node",
      CPA_HOME: "/data/cpa",
    });
    assert.equal(child.PATH, "/usr/bin");
    assert.equal(child.HOME, "/home/user");
    assert.equal(child.CPA_HOME, "/data/cpa");
    for (const key of strippedEnvKeys()) {
      assert.equal(child[key], undefined);
    }
  });
});
