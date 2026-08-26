import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  appendPrivateLogLine,
  directorySizeBytes,
  formatBytes,
  rotateFileIfLarge,
  tailFile,
} from "./util.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-util-"));
  temps.push(dir);
  return dir;
}

describe("formatBytes", () => {
  it("formats units", () => {
    assert.equal(formatBytes(500), "500 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  });
});

describe("directorySizeBytes", () => {
  it("sums nested files", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "a"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a", "f.txt"), "hello");
    fs.writeFileSync(path.join(dir, "b.txt"), "world!");
    assert.equal(directorySizeBytes(dir), 5 + 6);
  });
});

describe("tailFile", () => {
  it("reads only the requested trailing lines", () => {
    const dir = tempDir();
    const file = path.join(dir, "cpa.log");
    fs.writeFileSync(file, Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n"));
    assert.equal(tailFile(file, 3), "line-97\nline-98\nline-99");
  });

  it("returns the full count for a file without a trailing newline", () => {
    const dir = tempDir();
    const file = path.join(dir, "cpa.log");
    fs.writeFileSync(file, "l1\nl2\nl3");
    assert.equal(tailFile(file, 1), "l3");
    assert.equal(tailFile(file, 2), "l2\nl3");
    assert.equal(tailFile(file, 3), "l1\nl2\nl3");
  });

  it("does not spend a line slot on the trailing newline", () => {
    const dir = tempDir();
    const file = path.join(dir, "cpa.log");
    fs.writeFileSync(file, "l1\nl2\nl3\n");
    assert.equal(tailFile(file, 1), "l3");
    assert.equal(tailFile(file, 2), "l2\nl3");
    assert.equal(tailFile(file, 3), "l1\nl2\nl3");
  });

  it("handles CRLF line endings", () => {
    const dir = tempDir();
    const file = path.join(dir, "cpa.log");
    fs.writeFileSync(file, "l1\r\nl2\r\nl3\r\n");
    assert.equal(tailFile(file, 2), "l2\nl3");
    assert.equal(tailFile(file, 3), "l1\nl2\nl3");
  });
});

describe("rotateFileIfLarge", () => {
  it("does nothing under threshold", () => {
    const dir = tempDir();
    const file = path.join(dir, "cpa.log");
    fs.writeFileSync(file, "small");
    assert.equal(rotateFileIfLarge(file, { maxBytes: 100, keep: 2 }), false);
    assert.equal(fs.existsSync(file), true);
  });

  it("rotates and keeps generations", () => {
    const dir = tempDir();
    const file = path.join(dir, "cpa.log");
    fs.writeFileSync(file, "current-payload");
    fs.writeFileSync(`${file}.1`, "old-1");
    assert.equal(rotateFileIfLarge(file, { maxBytes: 4, keep: 2 }), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "current-payload");
    assert.equal(fs.readFileSync(`${file}.2`, "utf8"), "old-1");
  });

  it("keeps a rotated sibling that could not be renamed", () => {
    const dir = tempDir();
    const file = path.join(dir, "cpa.log");
    fs.writeFileSync(file, "current-payload");
    fs.writeFileSync(`${file}.1`, "old-1");

    const realRename = fs.renameSync;
    try {
      // Simulate a filesystem that refuses every rename (Windows AV / EPERM):
      // a failed shift must never delete the log it could not move.
      fs.renameSync = (): never => {
        throw new Error("EPERM: operation not permitted, rename");
      };
      assert.equal(rotateFileIfLarge(file, { maxBytes: 4, keep: 2 }), false);
    } finally {
      fs.renameSync = realRename;
    }

    assert.equal(fs.existsSync(`${file}.1`), true);
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "old-1");
    assert.equal(fs.readFileSync(file, "utf8"), "current-payload");
  });
});

describe("appendPrivateLogLine", () => {
  it("accumulates one newline-terminated record per call", () => {
    const dir = tempDir();
    const file = path.join(dir, "logs", "minicpa.log");
    assert.equal(appendPrivateLogLine(file, "first"), true);
    assert.equal(appendPrivateLogLine(file, "second"), true);
    assert.equal(fs.readFileSync(file, "utf8"), "first\nsecond\n");
  });

  it("creates the parent directory", () => {
    const dir = tempDir();
    const file = path.join(dir, "missing", "nested", "minicpa.log");
    assert.equal(appendPrivateLogLine(file, "line"), true);
    assert.equal(fs.existsSync(file), true);
  });

  it("rotates once the file outgrows the threshold", () => {
    const dir = tempDir();
    const file = path.join(dir, "minicpa.log");
    appendPrivateLogLine(file, "old-record", { maxBytes: 4 });
    appendPrivateLogLine(file, "new-record", { maxBytes: 4 });
    assert.equal(fs.readFileSync(file, "utf8"), "new-record\n");
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "old-record\n");
  });

  it("keeps the log private on POSIX", { skip: process.platform === "win32" }, () => {
    const dir = tempDir();
    const file = path.join(dir, "minicpa.log");
    fs.writeFileSync(file, "pre-existing\n", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    assert.equal(appendPrivateLogLine(file, "line"), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it("reports failure instead of throwing when the log cannot be written", () => {
    const dir = tempDir();
    // A directory where the log file belongs makes every open fail (EISDIR).
    const file = path.join(dir, "minicpa.log");
    fs.mkdirSync(file, { recursive: true });
    assert.equal(appendPrivateLogLine(file, "line"), false);
  });
});
