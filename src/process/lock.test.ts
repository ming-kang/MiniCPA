import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { withHomeLock } from "./lock.js";

const tempHomes: string[] = [];
const childPids: number[] = [];

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
  for (const pid of childPids.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
});

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-lock-"));
  tempHomes.push(home);
  return home;
}

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

describe("withHomeLock", () => {
  it("runs exclusive work and releases", async () => {
    const home = makeHome();
    let ran = false;
    await withHomeLock(home, "test", async () => {
      ran = true;
      const lockPath = path.join(home, "state", "cpa.lock");
      assert.ok(fs.existsSync(lockPath));
    });
    assert.equal(ran, true);
    assert.equal(fs.existsSync(path.join(home, "state", "cpa.lock")), false);
  });

  it("preempts stale lock from dead pid", async () => {
    const home = makeHome();
    const stateDir = path.join(home, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "cpa.lock"),
      JSON.stringify({ pid: 999_999_999, command: "stale", acquiredAt: new Date().toISOString() }) +
        "\n",
    );
    await withHomeLock(home, "test", async () => {
      /* acquired */
    });
    assert.equal(fs.existsSync(path.join(home, "state", "cpa.lock")), false);
  });

  it("rejects live holder from another process", async () => {
    const home = makeHome();
    const holderPid = spawnLiveHolder();
    const stateDir = path.join(home, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "cpa.lock"),
      JSON.stringify({
        pid: holderPid,
        command: "start",
        acquiredAt: new Date().toISOString(),
      }) + "\n",
    );
    await assert.rejects(
      () => withHomeLock(home, "update", async () => undefined),
      /Another cpa start is running/,
    );
  });

  it("supports re-entrant acquire in same process", async () => {
    const home = makeHome();
    await withHomeLock(home, "outer", async () => {
      await withHomeLock(home, "inner", async () => {
        assert.ok(fs.existsSync(path.join(home, "state", "cpa.lock")));
      });
      assert.ok(fs.existsSync(path.join(home, "state", "cpa.lock")));
    });
    assert.equal(fs.existsSync(path.join(home, "state", "cpa.lock")), false);
  });
});
