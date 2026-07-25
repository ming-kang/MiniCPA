import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { writeFileAtomic } from "./fs-atomic.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeFileAtomic", () => {
  it("writes readable content", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-atomic-"));
    temps.push(dir);
    const file = path.join(dir, "state.json");
    writeFileAtomic(file, JSON.stringify({ ok: true }) + "\n");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).ok, true);
  });

  it("writes a private file by default on POSIX", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-atomic-"));
    temps.push(dir);
    const file = path.join(dir, "secret.json");
    writeFileAtomic(file, "secret");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o077, 0);
      assert.equal(fs.statSync(dir).mode & 0o077, 0);
    }
  });

  it("overwrites existing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-atomic-"));
    temps.push(dir);
    const file = path.join(dir, "state.json");
    writeFileAtomic(file, "one");
    writeFileAtomic(file, "two");
    assert.equal(fs.readFileSync(file, "utf8"), "two");
  });
});
