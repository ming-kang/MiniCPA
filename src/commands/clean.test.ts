import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { cpaHome, miniCpaRoot, miniCpaTempRoot } from "../paths.js";
import { withMiniCpaLock, withMiniCpaUpdateLock } from "../process/lock.js";
import { cleanupPreviousUpdateOperations, cleanupTempFiles } from "../temp-files.js";
import { captureConsole, createIsolatedTestEnv } from "../test-fixtures/test-env.js";
import { runClean } from "./clean.js";

let env: ReturnType<typeof createIsolatedTestEnv> | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});
function isolate(): void {
  env = createIsolatedTestEnv("minicpa-clean-");
}
function operation(name: string, group = "operations", old = true): string {
  const directory = path.join(miniCpaTempRoot(), group, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "payload"), "fixture");
  if (old) {
    const date = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(directory, date, date);
  }
  return directory;
}

describe("runClean", () => {
  it("removes only private staging and never instance config/auths", async () => {
    isolate();
    operation("update-old");
    const config = path.join(cpaHome(), "config.yaml");
    fs.mkdirSync(cpaHome(), { recursive: true });
    fs.writeFileSync(config, "keep");
    await captureConsole(() => runClean({ minAgeMs: 0 }));
    assert.equal(fs.existsSync(miniCpaTempRoot()), false);
    assert.equal(fs.readFileSync(config, "utf8"), "keep");
  });

  it("cleans stale downloads even when their shared parent contains a new download", async () => {
    isolate();
    const stale = operation("binary-old", "downloads");
    const fresh = operation("binary-fresh", "downloads", false);
    const now = new Date();
    fs.utimesSync(path.dirname(fresh), now, now);
    await captureConsole(() => runClean());
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
  });

  it("reports a failed removal, keeps the residue, and exits nonzero", async () => {
    isolate();
    const locked = operation("update-locked");
    const originalRm = fs.promises.rm;
    fs.promises.rm = async (file, options) => {
      if (String(file) === locked)
        throw Object.assign(new Error("resource locked"), { code: "EBUSY" });
      return originalRm(file, options);
    };
    let output: Awaited<ReturnType<typeof captureConsole>>;
    try {
      output = await captureConsole(() => runClean({ minAgeMs: 0 }));
    } finally {
      fs.promises.rm = originalRm;
    }
    assert.match(output.stdout.join("\n"), /could not remove.*resource locked/);
    assert.match(output.stdout.join("\n"), /1 could not be removed/);
    assert.equal(process.exitCode, 1);
    assert.equal(fs.existsSync(locked), true);
  });

  it("cannot delete an active operation, even if its directory is very old", async () => {
    isolate();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active = "";
    const holding = withMiniCpaUpdateLock("update", async () => {
      active = operation("update-active");
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    try {
      await assert.rejects(() => runClean({ minAgeMs: 0 }), /lock|running/i);
      assert.equal(fs.existsSync(active), true);
      await withMiniCpaLock("start", async () => {});
    } finally {
      release();
      await holding;
    }
  });

  it("does not block lifecycle commands or pre-scan sizes while deleting a tree", async () => {
    isolate();
    const old = operation("update-old");
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalRm = fs.promises.rm;
    const originalReadDir = fs.readdirSync;
    fs.promises.rm = async (file, options) => {
      if (String(file) === old) {
        entered();
        await blocked;
      }
      return originalRm(file, options);
    };
    fs.readdirSync = ((..._args: unknown[]) => {
      throw new Error("unnecessary size walk");
    }) as typeof fs.readdirSync;
    const cleaning = captureConsole(() => runClean());
    try {
      await ready;
      assert.equal(fs.existsSync(path.join(miniCpaRoot(), "state", "cpa.lock")), false);
      await withMiniCpaLock("stop", async () => {});
    } finally {
      release();
      try {
        await cleaning;
      } finally {
        fs.promises.rm = originalRm;
        fs.readdirSync = originalReadDir;
      }
    }
    assert.equal(fs.existsSync(old), false);
  });

  it("removes a staging symlink/junction without deleting its destination", async () => {
    isolate();
    const outside = path.join(env!.baseDir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret"), "keep");
    fs.mkdirSync(miniCpaTempRoot(), { recursive: true });
    const link = path.join(miniCpaTempRoot(), "extract-link");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    await captureConsole(() => runClean({ minAgeMs: 0 }));
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.readFileSync(path.join(outside, "secret"), "utf8"), "keep");
  });

  it("refuses a symlinked temp root rather than cleaning unrelated data", async () => {
    isolate();
    const outside = path.join(env!.baseDir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret"), "keep");
    fs.mkdirSync(miniCpaRoot(), { recursive: true });
    fs.symlinkSync(outside, miniCpaTempRoot(), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => runClean({ minAgeMs: 0 }), /Refusing symlinked MiniCPA temp root/);
    assert.equal(fs.readFileSync(path.join(outside, "secret"), "utf8"), "keep");
  });

  it("never follows an operations-directory symlink during orphan cleanup", async () => {
    isolate();
    const outside = path.join(env!.baseDir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret"), "keep");
    fs.mkdirSync(miniCpaTempRoot(), { recursive: true });
    fs.symlinkSync(
      outside,
      path.join(miniCpaTempRoot(), "operations"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await withMiniCpaUpdateLock("update", async () => {
      await assert.rejects(
        () => cleanupPreviousUpdateOperations(),
        /Refusing symlinked update operations directory/,
      );
    });
    assert.equal(fs.readFileSync(path.join(outside, "secret"), "utf8"), "keep");
  });

  it("bounds automatic maintenance but leaves explicit clean able to finish", async () => {
    isolate();
    for (let index = 0; index < 5; index++) operation(`update-${index}`);
    await withMiniCpaUpdateLock("update", async () => {
      assert.equal((await cleanupTempFiles({ maxEntries: 2 })).removed, 2);
    });
    assert.equal(fs.readdirSync(path.join(miniCpaTempRoot(), "operations")).length, 3);
    await captureConsole(() => runClean());
    assert.equal(fs.existsSync(miniCpaTempRoot()), false);
  });
});
