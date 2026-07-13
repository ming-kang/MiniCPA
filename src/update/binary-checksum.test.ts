import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { verifyArchiveChecksum } from "./binary.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeTempArchive(content: string, name = "CLIProxyAPI_7.0.0_windows_amd64.zip"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-cksum-"));
  temps.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe("verifyArchiveChecksum", () => {
  it("accepts matching archive checksum (upstream checksums.txt style)", () => {
    const archiveName = "CLIProxyAPI_7.0.0_windows_amd64.zip";
    const content = "hello-archive";
    const archivePath = writeTempArchive(content, archiveName);
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    const map = new Map([[archiveName, digest]]);
    assert.doesNotThrow(() => verifyArchiveChecksum(map, archivePath, archiveName));
  });

  it("rejects mismatch", () => {
    const archiveName = "CLIProxyAPI_7.0.0_windows_amd64.zip";
    const archivePath = writeTempArchive("payload", archiveName);
    const map = new Map([[archiveName, "a".repeat(64)]]);
    assert.throws(
      () => verifyArchiveChecksum(map, archivePath, archiveName),
      /Checksum mismatch/,
    );
  });

  it("rejects missing key", () => {
    const archiveName = "CLIProxyAPI_7.0.0_windows_amd64.zip";
    const archivePath = writeTempArchive("payload", archiveName);
    const map = new Map([["other.zip", "b".repeat(64)]]);
    assert.throws(
      () => verifyArchiveChecksum(map, archivePath, archiveName),
      /No checksum entry for archive/,
    );
  });

  it("rejects empty map", () => {
    const archiveName = "CLIProxyAPI_7.0.0_windows_amd64.zip";
    const archivePath = writeTempArchive("payload", archiveName);
    assert.throws(
      () => verifyArchiveChecksum(new Map(), archivePath, archiveName),
      /No checksums available/,
    );
  });

  it("skips when insecure", () => {
    const archiveName = "CLIProxyAPI_7.0.0_windows_amd64.zip";
    const archivePath = writeTempArchive("payload", archiveName);
    assert.doesNotThrow(() =>
      verifyArchiveChecksum(new Map(), archivePath, archiveName, { insecure: true }),
    );
  });
});
