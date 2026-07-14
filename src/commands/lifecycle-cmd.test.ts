import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLogLineCount } from "./lifecycle-cmd.js";

describe("parseLogLineCount", () => {
  it("accepts positive whole numbers", () => {
    assert.equal(parseLogLineCount("80"), 80);
  });

  it("rejects invalid values", () => {
    for (const value of ["0", "-1", "12.5", "12logs", "", "999999999999999999999"]) {
      assert.throws(() => parseLogLineCount(value), /positive whole number/);
    }
  });
});
