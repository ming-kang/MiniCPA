import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyProcessIdentity,
  exePathsMatch,
  imageMatchesExpectedExe,
  parseTasklistImageName,
  readProcessStartMarker,
} from "./pid-identity.js";

describe("classifyProcessIdentity", () => {
  it("recognizes the current executable by exact path", () => {
    assert.equal(classifyProcessIdentity(process.pid, process.execPath), "match");
  });
});

describe("imageMatchesExpectedExe", () => {
  it("matches exact basenames", () => {
    assert.equal(imageMatchesExpectedExe("cli-proxy-api", "/home/x/cli-proxy-api"), true);
    assert.equal(imageMatchesExpectedExe("cli-proxy-api.exe", "C:\\a\\cli-proxy-api.exe"), true);
  });

  it("allows truncated linux comm only when observed is exactly 15 chars", () => {
    const fullName = "cli-proxy-api-xx"; // 16 chars
    const truncated15 = fullName.slice(0, 15);
    assert.equal(truncated15.length, 15);
    assert.equal(imageMatchesExpectedExe(truncated15, fullName), true);
  });

  it("rejects short prefixes that are not true comm truncation", () => {
    assert.equal(imageMatchesExpectedExe("cli", "cli-proxy-api"), false);
    assert.equal(imageMatchesExpectedExe("cli-proxy", "cli-proxy-api"), false);
    assert.equal(imageMatchesExpectedExe("c", "cli-proxy-api"), false);
  });

  it("rejects unrelated images", () => {
    assert.equal(imageMatchesExpectedExe("chrome", "cli-proxy-api"), false);
    assert.equal(imageMatchesExpectedExe("node", "/bin/cli-proxy-api"), false);
    assert.equal(imageMatchesExpectedExe("cli-proxy-api-other", "cli-proxy-api"), false);
  });
});

describe("exePathsMatch", () => {
  it("accepts the same resolved path", () => {
    assert.equal(
      exePathsMatch("/opt/cpa/cli-proxy-api", "/opt/cpa/cli-proxy-api"),
      true,
    );
  });

  it("rejects a different binary with the same basename", () => {
    assert.equal(
      exePathsMatch("/opt/other/cli-proxy-api", "/opt/managed/cli-proxy-api"),
      false,
    );
  });
});

describe("readProcessStartMarker", () => {
  it("returns a stable marker for the current process", () => {
    const first = readProcessStartMarker(process.pid);
    const second = readProcessStartMarker(process.pid);
    assert.ok(first);
    assert.equal(second, first);
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
    assert.equal(
      parseTasklistImageName(
        "INFO: No tasks are running which match the specified criteria.",
      ),
      undefined,
    );
  });
});
