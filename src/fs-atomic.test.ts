import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { renameWithWindowsRetry, replaceBackupPath, writeFileAtomic } from "./fs-atomic.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-atomic-"));
  temps.push(dir);
  return dir;
}

function errnoError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`stub ${code}`);
  err.code = code;
  return err;
}

/** Replace fs.renameSync for the duration of `run`, always restoring it. */
function withStubbedRename(stub: typeof fs.renameSync, run: () => void): void {
  const original = fs.renameSync;
  fs.renameSync = stub;
  try {
    run();
  } finally {
    fs.renameSync = original;
  }
}

describe("writeFileAtomic", () => {
  it("writes readable content", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-atomic-"));
    temps.push(dir);
    const file = path.join(dir, "state.json");
    writeFileAtomic(file, `${JSON.stringify({ ok: true })}\n`);
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

  it("can preserve an existing standard directory mode", () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    fs.chmodSync(dir, 0o755);
    writeFileAtomic(path.join(dir, "launcher.conf"), "launcher", { hardenDirectory: false });
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
  });

  it("overwrites existing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-atomic-"));
    temps.push(dir);
    const file = path.join(dir, "state.json");
    writeFileAtomic(file, "one");
    writeFileAtomic(file, "two");
    assert.equal(fs.readFileSync(file, "utf8"), "two");
  });

  it("restores an orphaned replace backup when the target is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-atomic-"));
    temps.push(dir);
    const file = path.join(dir, "cpa.pid");
    // Simulate a crash between move-aside and rename: only the backup remains.
    fs.writeFileSync(replaceBackupPath(file), "orphaned-content");
    writeFileAtomic(file, "fresh");
    assert.equal(fs.readFileSync(file, "utf8"), "fresh");
    assert.equal(fs.existsSync(replaceBackupPath(file)), false);
  });

  it("drops stale backup residue when the target survived the replace", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-atomic-"));
    temps.push(dir);
    const file = path.join(dir, "install.json");
    fs.writeFileSync(file, "current");
    fs.writeFileSync(replaceBackupPath(file), "stale");
    writeFileAtomic(file, "next");
    assert.equal(fs.readFileSync(file, "utf8"), "next");
    assert.equal(fs.existsSync(replaceBackupPath(file)), false);
  });

  it("lands the new content when the first rename hits a transient EPERM", () => {
    const dir = tempDir();
    const file = path.join(dir, "state.json");
    fs.writeFileSync(file, "before");

    const original = fs.renameSync;
    // Two failures exceed what the single-shot rename-aside fallback can absorb,
    // so only the Windows retry can complete this write.
    let failures = 2;
    withStubbedRename(
      (from, to) => {
        if (failures > 0) {
          failures -= 1;
          throw errnoError("EPERM");
        }
        original(from, to);
      },
      () => {
        if (process.platform === "win32") {
          writeFileAtomic(file, "after");
        } else {
          // Off Windows the transient-lock hazard does not exist and there is no
          // retry; the fallback must still leave the original file intact.
          assert.throws(() => writeFileAtomic(file, "after"), /EPERM/);
        }
      },
    );

    assert.equal(fs.readFileSync(file, "utf8"), process.platform === "win32" ? "after" : "before");
    assert.equal(fs.existsSync(replaceBackupPath(file)), false);
  });

  it("restores the original file when every rename keeps failing", () => {
    const dir = tempDir();
    const file = path.join(dir, "state.json");
    fs.writeFileSync(file, "original");

    withStubbedRename(
      () => {
        throw errnoError("EBUSY");
      },
      () => {
        assert.throws(() => writeFileAtomic(file, "doomed"), /EBUSY/);
      },
    );

    assert.equal(fs.readFileSync(file, "utf8"), "original");
    assert.equal(fs.readdirSync(dir).length, 1, "expected no temp or backup residue");
  });
});

describe("renameWithWindowsRetry", () => {
  it("retries a transient sharing violation on win32", () => {
    const dir = tempDir();
    const from = path.join(dir, "source");
    const to = path.join(dir, "target");
    fs.writeFileSync(from, "payload");

    const original = fs.renameSync;
    let attempts = 0;
    withStubbedRename(
      (a, b) => {
        attempts += 1;
        if (attempts <= 3) throw errnoError(["EPERM", "EBUSY", "EACCES"][attempts - 1] ?? "EPERM");
        original(a, b);
      },
      () => {
        renameWithWindowsRetry(from, to, "win32");
      },
    );

    assert.equal(attempts, 4);
    assert.equal(fs.readFileSync(to, "utf8"), "payload");
  });

  it("gives up after five win32 attempts", () => {
    let attempts = 0;
    withStubbedRename(
      () => {
        attempts += 1;
        throw errnoError("EBUSY");
      },
      () => {
        assert.throws(() => renameWithWindowsRetry("a", "b", "win32"), /EBUSY/);
      },
    );
    assert.equal(attempts, 5);
  });

  it("does not retry a non-transient error code", () => {
    let attempts = 0;
    withStubbedRename(
      () => {
        attempts += 1;
        throw errnoError("EXDEV");
      },
      () => {
        assert.throws(() => renameWithWindowsRetry("a", "b", "win32"), /EXDEV/);
      },
    );
    assert.equal(attempts, 1);
  });

  it("does not retry off win32", () => {
    let attempts = 0;
    withStubbedRename(
      () => {
        attempts += 1;
        throw errnoError("EPERM");
      },
      () => {
        assert.throws(() => renameWithWindowsRetry("a", "b", "linux"), /EPERM/);
      },
    );
    assert.equal(attempts, 1);
  });
});
