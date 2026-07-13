import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { findSafeExtractedExecutable } from "./binary.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("findSafeExtractedExecutable", () => {
  it("finds nested executable inside staging", () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-extract-"));
    temps.push(dest);
    const nested = path.join(dest, "nested");
    fs.mkdirSync(nested);
    const exeName = "cli-proxy-api";
    const exePath = path.join(nested, exeName);
    fs.writeFileSync(exePath, "bin");
    const found = findSafeExtractedExecutable(dest, exeName);
    assert.equal(path.basename(found), exeName);
    assert.ok(found.startsWith(fs.realpathSync(dest)));
  });

  it("throws when missing", () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-extract-"));
    temps.push(dest);
    assert.throws(() => findSafeExtractedExecutable(dest, "cli-proxy-api"), /not found/);
  });
});
