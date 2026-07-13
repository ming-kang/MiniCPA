import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertUpdateScopeFlags } from "./update-cmd.js";

describe("assertUpdateScopeFlags", () => {
  it("allows zero or one scope flag", () => {
    assert.doesNotThrow(() => assertUpdateScopeFlags({}));
    assert.doesNotThrow(() => assertUpdateScopeFlags({ binary: true }));
    assert.doesNotThrow(() => assertUpdateScopeFlags({ panel: true }));
    assert.doesNotThrow(() => assertUpdateScopeFlags({ all: true }));
  });

  it("rejects combinations", () => {
    assert.throws(() => assertUpdateScopeFlags({ binary: true, panel: true }), /only one/);
    assert.throws(() => assertUpdateScopeFlags({ all: true, binary: true }), /only one/);
    assert.throws(() => assertUpdateScopeFlags({ all: true, panel: true }), /only one/);
  });
});
