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

  it("overwrites existing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-atomic-"));
    temps.push(dir);
    const file = path.join(dir, "state.json");
    writeFileAtomic(file, "one");
    writeFileAtomic(file, "two");
    assert.equal(fs.readFileSync(file, "utf8"), "two");
  });
});
