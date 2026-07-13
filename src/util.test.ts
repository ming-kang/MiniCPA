import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  directorySizeBytes,
  formatBytes,
  parseCpaVersionFromHelp,
  rotateFileIfLarge,
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

describe("parseCpaVersionFromHelp", () => {
  it("extracts version line", () => {
    assert.equal(
      parseCpaVersionFromHelp("CLIProxyAPI Version: 7.2.66\nUsage:"),
      "7.2.66",
    );
  });

  it("returns undefined when missing", () => {
    assert.equal(parseCpaVersionFromHelp("no version here"), undefined);
  });
});

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
});
