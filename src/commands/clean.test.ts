import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { miniCpaTempRoot } from "../paths.js";
import { runClean } from "./clean.js";

const originalLocalAppData = process.env.LOCALAPPDATA;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalHome = process.env.HOME;
const originalExitCode = process.exitCode;
const temps: string[] = [];

function setAppDataRoot(base: string): void {
  process.env.LOCALAPPDATA = base;
  process.env.XDG_DATA_HOME = base;
  process.env.HOME = base;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  process.exitCode = originalExitCode;
});

describe("runClean", () => {
  it("removes only the private MiniCPA staging tree", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-clean-base-"));
    temps.push(base);
    setAppDataRoot(base);

    const miniTemp = miniCpaTempRoot();
    fs.mkdirSync(path.join(miniTemp, "downloads"), { recursive: true });
    fs.writeFileSync(path.join(miniTemp, "downloads", "x.zip"), "payload");
    const old = new Date(Date.now() - 1_000);
    fs.utimesSync(path.join(miniTemp, "downloads"), old, old);

    const sibling = path.join(base, "instance-config.yaml");
    fs.writeFileSync(sibling, "keep-me");

    await runClean({ minAgeMs: 0 });

    assert.equal(fs.existsSync(miniTemp), false);
    assert.equal(fs.readFileSync(sibling, "utf8"), "keep-me");
  });

  it("reports and fails when an entry cannot be removed", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-clean-base-"));
    temps.push(base);
    setAppDataRoot(base);

    const miniTemp = miniCpaTempRoot();
    const locked = path.join(miniTemp, "downloads");
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, "x.zip"), "payload");

    const lines: string[] = [];
    const originalLog = console.log;
    const originalRmSync = fs.rmSync;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    fs.rmSync = ((target: fs.PathLike, options?: fs.RmOptions): void => {
      if (String(target) === locked) {
        const err: NodeJS.ErrnoException = new Error("EBUSY: resource busy or locked");
        err.code = "EBUSY";
        throw err;
      }
      originalRmSync(target, options);
    }) as typeof fs.rmSync;
    try {
      await runClean({ minAgeMs: 0 });
    } finally {
      fs.rmSync = originalRmSync;
      console.log = originalLog;
    }

    assert.ok(
      lines.some((line) => line.includes("could not remove")),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((line) => line.includes("1 could not be removed")),
      lines.join("\n"),
    );
    assert.equal(process.exitCode, 1);
    assert.equal(fs.existsSync(locked), true);
  });

  it("keeps recent staging entries by default", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-clean-base-"));
    temps.push(base);
    setAppDataRoot(base);

    const miniTemp = miniCpaTempRoot();
    fs.mkdirSync(path.join(miniTemp, "downloads"), { recursive: true });
    const fresh = path.join(miniTemp, "downloads", "fresh.zip");
    fs.writeFileSync(fresh, "payload");

    await runClean({ minAgeMs: 60 * 60 * 1000 });

    assert.equal(fs.existsSync(fresh), true);
  });
});
