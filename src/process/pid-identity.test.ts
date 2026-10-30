import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalizeStartMarker,
  classifyDarwinComm,
  classifyProcessIdentity,
  compareStartMarkers,
  exePathsMatch,
  imageMatchesExpectedExe,
  isTaggedStartMarker,
  readProcessStartMarker,
} from "./pid-identity.js";

describe("classifyProcessIdentity", () => {
  it("recognizes the current executable by exact path", async () => {
    assert.equal(await classifyProcessIdentity(process.pid, process.execPath), "match");
  });
});

describe("imageMatchesExpectedExe", () => {
  it("matches exact basenames", () => {
    assert.equal(imageMatchesExpectedExe("cli-proxy-api", "/home/x/cli-proxy-api"), true);
    assert.equal(imageMatchesExpectedExe("cli-proxy-api.exe", "C:\\a\\cli-proxy-api.exe"), true);
  });

  it("allows truncated linux comm only when observed is exactly 15 chars", () => {
    const fullName = "cli-proxy-api-xx";
    const truncated15 = fullName.slice(0, 15);
    assert.equal(truncated15.length, 15);
    assert.equal(imageMatchesExpectedExe(truncated15, fullName), true);
  });

  it("rejects short prefixes that are not true comm truncation", () => {
    for (const prefix of ["cli", "cli-proxy", "c"]) {
      assert.equal(imageMatchesExpectedExe(prefix, "cli-proxy-api"), false);
    }
  });

  it("rejects unrelated images", () => {
    assert.equal(imageMatchesExpectedExe("chrome", "cli-proxy-api"), false);
    assert.equal(imageMatchesExpectedExe("node", "/bin/cli-proxy-api"), false);
    assert.equal(imageMatchesExpectedExe("cli-proxy-api-other", "cli-proxy-api"), false);
  });
});

describe("exePathsMatch", () => {
  it("accepts the same resolved path", () => {
    assert.equal(exePathsMatch("/opt/cpa/cli-proxy-api", "/opt/cpa/cli-proxy-api"), true);
  });

  it("rejects a different binary with the same basename", () => {
    assert.equal(exePathsMatch("/opt/other/cli-proxy-api", "/opt/managed/cli-proxy-api"), false);
  });
});

describe("classifyDarwinComm", () => {
  const expected =
    "/Users/asterin-with-a-long-home-directory/Library/Application Support/MiniCPA/instance/cli-proxy-api";

  it("uses a fixture path exceeding the 79-column ps pipe width", () => {
    assert.ok(expected.length > 79);
  });

  it("matches the exact absolute path", () => {
    assert.equal(classifyDarwinComm(expected, expected), "match");
    assert.equal(classifyDarwinComm(`${expected}\n`, expected), "match");
  });

  it("treats a truncated absolute path as unknown, never mismatch", () => {
    for (const truncated of [expected.slice(0, -1), expected.slice(0, 79)]) {
      assert.notEqual(truncated, expected);
      assert.equal(classifyDarwinComm(truncated, expected), "unknown");
    }
  });

  it("reports an unrelated absolute path as mismatch", () => {
    assert.equal(classifyDarwinComm("/usr/sbin/sshd", expected), "mismatch");
    assert.equal(classifyDarwinComm("/bin/zsh", expected), "mismatch");
  });

  it("does not treat a longer path sharing the tail as truncation", () => {
    assert.equal(classifyDarwinComm(`${expected}-other`, expected), "mismatch");
  });

  it("treats a bare matching basename as unknown", () => {
    assert.equal(classifyDarwinComm("cli-proxy-api", expected), "unknown");
  });

  it("reports a bare unrelated basename as mismatch", () => {
    assert.equal(classifyDarwinComm("sshd", expected), "mismatch");
  });

  it("reports empty output as mismatch", () => {
    assert.equal(classifyDarwinComm("", expected), "mismatch");
    assert.equal(classifyDarwinComm("   \n", expected), "mismatch");
  });
});

describe("readProcessStartMarker", () => {
  it("returns a stable marker for the current process", async () => {
    const first = await readProcessStartMarker(process.pid);
    const second = await readProcessStartMarker(process.pid);
    assert.ok(first);
    assert.equal(second, first);
  });

  it("tags darwin markers and leaves other platform shapes untagged", async () => {
    const marker = await readProcessStartMarker(process.pid);
    assert.ok(marker);
    assert.equal(isTaggedStartMarker(marker), process.platform === "darwin");
  });
});

describe("canonicalizeStartMarker", () => {
  it("collapses ps lstart renderings of the same instant to one UTC value", () => {
    const padded = "Mon Jul  6 03:01:00 2026";
    const single = "Mon Jul 6 03:01:00 2026";
    assert.equal(canonicalizeStartMarker(padded), canonicalizeStartMarker(single));
    assert.equal(canonicalizeStartMarker(` ${padded}\n`), canonicalizeStartMarker(single));
    assert.equal(
      canonicalizeStartMarker(padded),
      `lstart-utc:${Date.UTC(2026, 6, 6, 3, 1, 0) / 1000}`,
    );
  });

  it("keeps distinct start times distinct", () => {
    assert.notEqual(
      canonicalizeStartMarker("Mon Jul 6 03:01:00 2026"),
      canonicalizeStartMarker("Mon Jul 6 03:01:01 2026"),
    );
  });

  it("passes non-lstart markers through unchanged", () => {
    for (const marker of ["boot-id:12345", "638000000000000", "lstart-utc:1785"]) {
      assert.equal(canonicalizeStartMarker(marker), marker);
    }
  });

  it("emits a tag no marker from an untagged build can collide with", () => {
    assert.equal(isTaggedStartMarker(canonicalizeStartMarker("Mon Jul 6 03:01:00 2026")), true);
    for (const legacy of [
      "Mon Jul 6 03:01:00 2026",
      "Mo 6 Jul 03:01:00 2026",
      "boot-id:12345",
      "638000000000000",
    ]) {
      assert.equal(isTaggedStartMarker(legacy), false);
    }
  });

  it("is idempotent for tagged markers", () => {
    const canonical = canonicalizeStartMarker("Mon Jul 6 03:01:00 2026");
    assert.equal(canonicalizeStartMarker(canonical), canonical);
  });

  it("cannot recover the timezone of legacy wall-clock text", () => {
    const tagged = canonicalizeStartMarker("Mon Jul 6 03:01:00 2026");
    const legacyLocal = "Mon Jul 6 05:01:00 2026";
    assert.notEqual(canonicalizeStartMarker(legacyLocal), tagged);
    assert.equal(compareStartMarkers(legacyLocal, tagged), "unknown");
  });
});

describe("compareStartMarkers", () => {
  it("distinguishes identity from PID reuse in every comparable format", () => {
    const cases = [
      ["boot-id:12345", "boot-id:12345", "same"],
      ["boot-id:12345", "boot-id:12346", "reused"],
      ["boot-a:12345", "boot-b:12345", "reused"],
      ["638000000000000", "638000000000000", "same"],
      ["638000000000000", "638000000000001", "reused"],
      ["lstart-utc:1783306860", "lstart-utc:1783306860", "same"],
      ["lstart-utc:1783306860", "lstart-utc:1783306861", "reused"],
      ["Mon Jul 6 03:01:00 2026", "Mon Jul 6 03:01:00 2026", "same"],
      ["Mon Jul 6 03:01:00 2026", "Mon Jul 6 05:01:00 2026", "reused"],
    ] as const;
    for (const [recorded, current, expected] of cases) {
      assert.equal(compareStartMarkers(recorded, current), expected);
    }
  });

  it("normalizes incidental whitespace before comparing", () => {
    assert.equal(compareStartMarkers(" boot-id:12345\n", "boot-id:12345"), "same");
    assert.equal(compareStartMarkers("  lstart-utc:100 \n", "lstart-utc:200"), "reused");
    assert.equal(
      compareStartMarkers("Mon Jul  6 03:01:00 2026", " Mon Jul 6 03:01:00 2026 "),
      "same",
    );
    assert.equal(compareStartMarkers("boot:1", " boot:2 "), "reused");
  });

  it("cannot prove identity or reuse with missing, empty or whitespace-only markers", () => {
    for (const missing of [undefined, "", "   "]) {
      for (const present of ["boot-id:12345", "lstart-utc:100", undefined, ""]) {
        assert.equal(compareStartMarkers(missing, present), "unknown");
        assert.equal(compareStartMarkers(present, missing), "unknown");
      }
    }
  });

  it("never compares tagged Darwin instants with legacy or other untagged shapes", () => {
    const tagged = canonicalizeStartMarker("Mon Jul 6 03:01:00 2026");
    for (const untagged of [
      "Mon Jul 6 05:01:00 2026",
      "Mo 6 Jul 03:01:00 2026",
      "boot-id:12345",
      "638000000000000",
    ]) {
      assert.equal(compareStartMarkers(untagged, tagged), "unknown");
      assert.equal(compareStartMarkers(tagged, untagged), "unknown");
    }
  });
});
