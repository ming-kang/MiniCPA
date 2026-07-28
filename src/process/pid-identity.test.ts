import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalizeStartMarker,
  classifyDarwinComm,
  classifyProcessIdentity,
  exePathsMatch,
  imageMatchesExpectedExe,
  isTaggedStartMarker,
  parseTasklistImageName,
  probePidReuse,
  readProcessStartMarker,
  startMarkersProveReuse,
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
    assert.equal(exePathsMatch("/opt/cpa/cli-proxy-api", "/opt/cpa/cli-proxy-api"), true);
  });

  it("rejects a different binary with the same basename", () => {
    assert.equal(exePathsMatch("/opt/other/cli-proxy-api", "/opt/managed/cli-proxy-api"), false);
  });
});

describe("classifyDarwinComm", () => {
  // The default macOS install path; BSD ps truncates its last column to the
  // terminal width, and falls back to 79 columns when stdout is a pipe.
  const expected =
    "/Users/asterin/Library/Application Support/MiniCPA/instances/default/cli-proxy-api";

  it("uses a path longer than the 79-column ps fallback width", () => {
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
      assert.notEqual(classifyDarwinComm(truncated, expected), "mismatch");
    }
  });

  it("reports an unrelated absolute path as mismatch", () => {
    assert.equal(classifyDarwinComm("/usr/sbin/sshd", expected), "mismatch");
    assert.equal(classifyDarwinComm("/bin/zsh", expected), "mismatch");
  });

  it("does not treat a non-prefix path sharing the tail as truncation", () => {
    // Truncation only ever removes a suffix, so a longer observed path is never
    // a truncated view of the expected one.
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
  it("returns a stable marker for the current process", () => {
    const first = readProcessStartMarker(process.pid);
    const second = readProcessStartMarker(process.pid);
    assert.ok(first);
    assert.equal(second, first);
  });

  it("tags darwin markers and leaves the other platform shapes untagged", () => {
    // Darwin is the only platform whose raw marker is timezone-dependent, so it
    // is the only one that must be reduced to a tagged absolute instant at read
    // time. Linux (`<boot id>:<ticks>`) and Windows (UTC tick counts) are
    // already absolute and must keep their existing shape.
    const marker = readProcessStartMarker(process.pid);
    assert.ok(marker);
    assert.equal(isTaggedStartMarker(marker), process.platform === "darwin");
  });
});

describe("canonicalizeStartMarker", () => {
  it("collapses ps lstart renderings of the same instant to one value", () => {
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
      canonicalizeStartMarker("Mon Jul  6 03:01:00 2026"),
      canonicalizeStartMarker("Mon Jul  6 03:01:01 2026"),
    );
  });

  it("passes non-lstart markers through unchanged", () => {
    assert.equal(canonicalizeStartMarker("boot-id:12345"), "boot-id:12345");
    assert.equal(canonicalizeStartMarker("638000000000000"), "638000000000000");
    assert.equal(canonicalizeStartMarker("lstart-utc:1785"), "lstart-utc:1785");
  });

  it("emits a tag no marker recorded by an untagged build can collide with", () => {
    assert.equal(isTaggedStartMarker(canonicalizeStartMarker("Mon Jul  6 03:01:00 2026")), true);
    // Shapes a pre-tag MiniCPA could have written, plus the other platforms.
    for (const legacy of [
      "Mon Jul  6 03:01:00 2026",
      "Mo 6 Jul 03:01:00 2026",
      "boot-id:12345",
      "638000000000000",
    ]) {
      assert.equal(isTaggedStartMarker(legacy), false);
    }
  });

  it("is idempotent, so re-canonicalizing a tagged marker is a no-op", () => {
    const canonical = canonicalizeStartMarker("Mon Jul  6 03:01:00 2026");
    assert.equal(canonicalizeStartMarker(canonical), canonical);
  });

  it("cannot recover the timezone of wall-clock text recorded by an untagged build", () => {
    // This is why startMarkersProveReuse refuses to compare the two shapes:
    // canonicalization reads wall-clock text as UTC, which is only true for text
    // this build read under its pinned TZ=UTC probe. The same process start
    // recorded by MiniCPA 0.1.0 in a UTC+2 zone canonicalizes to a different
    // instant, and no amount of re-canonicalizing closes that gap.
    const tagged = canonicalizeStartMarker("Mon Jul  6 03:01:00 2026");
    const legacyLocal = "Mon Jul  6 05:01:00 2026";
    assert.notEqual(canonicalizeStartMarker(legacyLocal), tagged);
  });
});

describe("probePidReuse", () => {
  // The instant a live CPA started, as this build reads it under TZ=UTC, and as
  // MiniCPA 0.1.0 would have recorded the very same start in a UTC+2 zone.
  const taggedCurrent = canonicalizeStartMarker("Mon Jul  6 03:01:00 2026");
  const legacyLocalMarker = "Mon Jul  6 05:01:00 2026";

  it("does not report reuse when the recorded marker matches", () => {
    const recorded = readProcessStartMarker(process.pid);
    const probe = probePidReuse(process.pid, recorded);
    assert.equal(probe.reused, false);
    assert.equal(probe.currentMarker, recorded);
  });

  it("reports reuse when the recorded marker differs in the same shape", () => {
    const recorded = readProcessStartMarker(process.pid);
    assert.ok(recorded);
    // Appending a digit keeps the marker in its platform's shape (tagged stays
    // tagged, untagged stays untagged) while changing the value it encodes.
    const probe = probePidReuse(process.pid, `${recorded}0`);
    assert.equal(probe.reused, true);
  });

  it("cannot prove reuse without a recorded marker", () => {
    assert.equal(probePidReuse(process.pid, undefined).reused, false);
    assert.equal(probePidReuse(process.pid, "").reused, false);
  });

  it("cannot prove reuse for a pid with no readable marker", () => {
    const probe = probePidReuse(-1, "boot-id:12345");
    assert.equal(probe.currentMarker, undefined);
    assert.equal(probe.reused, false);
  });

  it("cannot prove reuse from a legacy local-time marker for the same live pid", () => {
    // First command after upgrading on macOS: the pid record still holds the
    // untagged wall-clock text 0.1.0 wrote, while the probe now returns a tagged
    // instant. Reading the legacy text as UTC would shift it by the machine's
    // UTC offset and condemn a healthy daemon as a reused PID.
    const probe = probePidReuse(process.pid, legacyLocalMarker, () => taggedCurrent);
    assert.equal(probe.currentMarker, taggedCurrent);
    assert.equal(probe.reused, false);
  });

  it("cannot prove reuse from a non-C-locale legacy marker", () => {
    // A German LC_TIME rendering does not even parse as C-locale lstart text, so
    // it would pass through raw and mismatch a tagged marker outright.
    const probe = probePidReuse(process.pid, "Mo 6 Jul 03:01:00 2026", () => taggedCurrent);
    assert.equal(probe.reused, false);
  });

  it("cannot prove reuse when only the recorded marker is tagged", () => {
    // The downgrade direction of the same mismatch.
    const probe = probePidReuse(process.pid, taggedCurrent, () => legacyLocalMarker);
    assert.equal(probe.reused, false);
  });

  it("still reports reuse between two different tagged markers", () => {
    const other = canonicalizeStartMarker("Mon Jul  6 03:01:01 2026");
    assert.notEqual(other, taggedCurrent);
    assert.equal(probePidReuse(process.pid, other, () => taggedCurrent).reused, true);
  });

  it("does not report reuse between identical tagged markers", () => {
    assert.equal(probePidReuse(process.pid, taggedCurrent, () => taggedCurrent).reused, false);
  });
});

describe("startMarkersProveReuse", () => {
  it("keeps linux boot-id markers comparable", () => {
    assert.equal(startMarkersProveReuse("boot-id:12345", "boot-id:12345"), false);
    assert.equal(startMarkersProveReuse("boot-id:12345", "boot-id:12346"), true);
    // A reboot changes the boot id, so identical ticks are still a new process.
    assert.equal(startMarkersProveReuse("boot-a:12345", "boot-b:12345"), true);
  });

  it("keeps windows tick markers comparable", () => {
    assert.equal(startMarkersProveReuse("638000000000000", "638000000000000"), false);
    assert.equal(startMarkersProveReuse("638000000000000", "638000000000001"), true);
  });

  it("ignores incidental whitespace", () => {
    assert.equal(startMarkersProveReuse(" boot-id:12345\n", "boot-id:12345"), false);
    assert.equal(
      startMarkersProveReuse("Mon Jul  6 03:01:00 2026", " Mon Jul 6 03:01:00 2026 "),
      false,
    );
  });

  it("cannot prove reuse from a missing or empty marker", () => {
    assert.equal(startMarkersProveReuse(undefined, "boot-id:12345"), false);
    assert.equal(startMarkersProveReuse("boot-id:12345", undefined), false);
    assert.equal(startMarkersProveReuse("", "boot-id:12345"), false);
    assert.equal(startMarkersProveReuse("boot-id:12345", "   "), false);
  });

  it("refuses to compare a tagged marker with any untagged shape", () => {
    const tagged = canonicalizeStartMarker("Mon Jul  6 03:01:00 2026");
    for (const untagged of [
      "Mon Jul  6 05:01:00 2026",
      "Mo 6 Jul 03:01:00 2026",
      "boot-id:12345",
      "638000000000000",
    ]) {
      assert.equal(startMarkersProveReuse(untagged, tagged), false);
      assert.equal(startMarkersProveReuse(tagged, untagged), false);
    }
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
      parseTasklistImageName("INFO: No tasks are running which match the specified criteria."),
      undefined,
    );
  });
});
