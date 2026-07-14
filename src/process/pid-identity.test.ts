import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { imageMatchesExpectedExe, parseTasklistImageName } from "./pid-identity.js";

describe("imageMatchesExpectedExe", () => {
  it("matches exact basenames", () => {
    assert.equal(imageMatchesExpectedExe("cli-proxy-api", "/home/x/cli-proxy-api"), true);
    assert.equal(imageMatchesExpectedExe("cli-proxy-api.exe", "C:\\a\\cli-proxy-api.exe"), true);
  });

  it("allows truncated linux comm when expected is longer", () => {
    // /proc/pid/comm max 15 chars; observed may be a prefix of the full name
    const fullName = "cli-proxy-api-x"; // 15 chars
    const truncated = fullName.slice(0, 12);
    assert.equal(imageMatchesExpectedExe(truncated, fullName), true);
  });

  it("rejects unrelated images", () => {
    assert.equal(imageMatchesExpectedExe("chrome", "cli-proxy-api"), false);
    assert.equal(imageMatchesExpectedExe("node", "/bin/cli-proxy-api"), false);
    assert.equal(imageMatchesExpectedExe("cli-proxy-api-other", "cli-proxy-api"), false);
  });
});

describe("parseTasklistImageName", () => {
  it("parses CSV quoted image", () => {
    assert.equal(
      parseTasklistImageName('"cli-proxy-api.exe","1234","Console"'),
      "cli-proxy-api.exe",
    );
  });

  it("returns undefined for INFO lines", () => {
    assert.equal(parseTasklistImageName("INFO: No tasks are running which match the specified criteria."), undefined);
  });
});
