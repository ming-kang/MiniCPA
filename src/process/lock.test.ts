import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { miniCpaRoot } from "../paths.js";
import { withMiniCpaLock } from "./lock.js";

const tempDirs: string[] = [];
const childPids: number[] = [];
const originalLocalAppData = process.env.LOCALAPPDATA;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalHome = process.env.HOME;

function configureIsolatedAppRoot(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-lock-root-"));
  tempDirs.push(root);
  process.env.LOCALAPPDATA = root;
  process.env.XDG_DATA_HOME = root;
  process.env.HOME = root;
}

function lockPath(): string {
  return path.join(miniCpaRoot(), "state", "cpa.lock");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const pid of childPids.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function spawnLiveHolder(): number {
  const child =
    process.platform === "win32"
      ? spawn("ping", ["-n", "30", "127.0.0.1"], {
          stdio: "ignore",
          windowsHide: true,
        })
      : spawn("sleep", ["30"], { stdio: "ignore" });
  if (!child.pid) throw new Error("failed to spawn holder");
  childPids.push(child.pid);
  return child.pid;
}

describe("withMiniCpaLock", () => {
  it("uses one global lock and releases it", async () => {
    configureIsolatedAppRoot();
    let ran = false;
    await withMiniCpaLock("test", async () => {
      ran = true;
      assert.ok(fs.existsSync(lockPath()));
    });
    assert.equal(ran, true);
    assert.equal(fs.existsSync(lockPath()), false);
  });

  it("preempts a stale global lock", async () => {
    configureIsolatedAppRoot();
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 999_999_999, command: "stale", acquiredAt: new Date().toISOString() }) +
        "\n",
    );
    await withMiniCpaLock("test", async () => {
      /* acquired */
    });
    assert.equal(fs.existsSync(lockPath()), false);
  });

  it("rejects a live holder globally", async () => {
    configureIsolatedAppRoot();
    const holderPid = spawnLiveHolder();
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: holderPid,
        command: "start",
        acquiredAt: new Date().toISOString(),
      }) + "\n",
    );
    await assert.rejects(
      () => withMiniCpaLock("update", async () => undefined),
      /Another cpa start is running/,
    );
    assert.ok(fs.existsSync(lockPath()));
  });

  it("supports intentional re-entrant acquire in the same process", async () => {
    configureIsolatedAppRoot();
    await withMiniCpaLock("outer", async () => {
      await withMiniCpaLock("inner", async () => {
        assert.ok(fs.existsSync(lockPath()));
      });
      assert.ok(fs.existsSync(lockPath()));
    });
    assert.equal(fs.existsSync(lockPath()), false);
  });
});
