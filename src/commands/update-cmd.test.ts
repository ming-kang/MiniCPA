import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertUpdateScopeFlags, updateCheckExitCode } from "./update-cmd.js";

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

  it("rejects binary-only flags combined with --panel", () => {
    assert.throws(
      () => assertUpdateScopeFlags({ panel: true, version: "7.2.66" }),
      /--version and --insecure apply to the CPA binary only/,
    );
    assert.throws(
      () => assertUpdateScopeFlags({ panel: true, insecure: true }),
      /--version and --insecure apply to the CPA binary only/,
    );
  });

  it("allows binary-only flags outside --panel", () => {
    assert.doesNotThrow(() => assertUpdateScopeFlags({ binary: true, version: "7.2.66" }));
    assert.doesNotThrow(() => assertUpdateScopeFlags({ binary: true, insecure: true }));
    assert.doesNotThrow(() => assertUpdateScopeFlags({ version: "7.2.66", insecure: true }));
    assert.doesNotThrow(() => assertUpdateScopeFlags({ panel: true }));
  });
});

describe("updateCheckExitCode", () => {
  it("exits 0 only when both targets are current and the panel check succeeded", () => {
    const cases: Array<[boolean, boolean, boolean, number]> = [
      [true, true, false, 0],
      [true, true, true, 1],
      [true, false, false, 1],
      [true, false, true, 1],
      [false, true, false, 1],
      [false, true, true, 1],
      [false, false, false, 1],
      [false, false, true, 1],
    ];
    for (const [binaryUpToDate, panelUpToDate, panelError, expected] of cases) {
      assert.equal(
        updateCheckExitCode(binaryUpToDate, panelUpToDate, panelError),
        expected,
        `binary=${binaryUpToDate} panel=${panelUpToDate} error=${panelError}`,
      );
    }
  });
});
