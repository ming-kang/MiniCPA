import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { executableName } from "../paths.js";
import { verifyBinaryChecksum } from "./binary.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeTempExe(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-cksum-"));
  temps.push(dir);
  const file = path.join(dir, executableName());
  fs.writeFileSync(file, content);
  return file;
}

describe("verifyBinaryChecksum", () => {
  it("accepts matching checksum", () => {
    const content = "hello-cpa";
    const exePath = writeTempExe(content);
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    const map = new Map([[executableName(), digest]]);
    assert.doesNotThrow(() =>
      verifyBinaryChecksum(map, "archive.zip", exePath),
    );
  });

  it("rejects mismatch", () => {
    const exePath = writeTempExe("payload");
    const map = new Map([[executableName(), "a".repeat(64)]]);
    assert.throws(
      () => verifyBinaryChecksum(map, "archive.zip", exePath),
      /Checksum mismatch/,
    );
  });

  it("rejects missing key", () => {
    const exePath = writeTempExe("payload");
    const map = new Map([["other-name", "b".repeat(64)]]);
    assert.throws(
      () => verifyBinaryChecksum(map, "archive.zip", exePath),
      /No checksum entry/,
    );
  });

  it("rejects empty map", () => {
    const exePath = writeTempExe("payload");
    assert.throws(
      () => verifyBinaryChecksum(new Map(), "archive.zip", exePath),
      /No checksums available/,
    );
  });

  it("skips when insecure", () => {
    const exePath = writeTempExe("payload");
    assert.doesNotThrow(() =>
      verifyBinaryChecksum(new Map(), "archive.zip", exePath, { insecure: true }),
    );
  });
});
