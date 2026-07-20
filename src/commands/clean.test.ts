import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { runClean } from "./clean.js";

const originalTmpdir = process.env.TMPDIR;
const originalTemp = process.env.TEMP;
const originalTmp = process.env.TMP;
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  if (originalTemp === undefined) delete process.env.TEMP;
  else process.env.TEMP = originalTemp;
  if (originalTmp === undefined) delete process.env.TMP;
  else process.env.TMP = originalTmp;
});

describe("runClean", () => {
  it("removes MiniCPA temp tree only", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-clean-base-"));
    temps.push(base);
    // Point os.tmpdir() at our sandbox (Node reads TEMP/TMP on Windows, TMPDIR on Unix).
    process.env.TMPDIR = base;
    process.env.TEMP = base;
    process.env.TMP = base;

    const miniTemp = path.join(base, "MiniCPA");
    fs.mkdirSync(path.join(miniTemp, "downloads"), { recursive: true });
    fs.writeFileSync(path.join(miniTemp, "downloads", "x.zip"), "payload");

    // Instance-like data outside MiniCPA temp must survive.
    const sibling = path.join(base, "instances-default-config.yaml");
    fs.writeFileSync(sibling, "keep-me");

    // minAgeMs 0: tests exercise full removal; default clean keeps recent files.
    await runClean({ minAgeMs: 0 });

    assert.equal(fs.existsSync(miniTemp), false);
    assert.equal(fs.readFileSync(sibling, "utf8"), "keep-me");
  });

  it("keeps recent temp entries by default", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-clean-base-"));
    temps.push(base);
    process.env.TMPDIR = base;
    process.env.TEMP = base;
    process.env.TMP = base;

    const miniTemp = path.join(base, "MiniCPA");
    fs.mkdirSync(path.join(miniTemp, "downloads"), { recursive: true });
    fs.writeFileSync(path.join(miniTemp, "downloads", "fresh.zip"), "payload");

    await runClean({ minAgeMs: 60 * 60 * 1000 });

    assert.equal(fs.existsSync(path.join(miniTemp, "downloads", "fresh.zip")), true);
  });
});
