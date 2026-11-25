import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { errnoCode, formatBytes, tailFile } from "./util.js";

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

describe("errnoCode", () => {
  it("returns only string codes", () => {
    assert.equal(errnoCode(Object.assign(new Error("x"), { code: "ENOENT" })), "ENOENT");
    assert.equal(errnoCode({ code: 42 }), undefined);
    assert.equal(errnoCode(new Error("x")), undefined);
    assert.equal(errnoCode(null), undefined);
    assert.equal(errnoCode("ENOENT"), undefined);
  });
});

describe("formatBytes", () => {
  it("formats units", () => {
    assert.equal(formatBytes(500), "500 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
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
