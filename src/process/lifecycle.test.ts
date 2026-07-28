import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { activeExecutablePath, backupExecutablePath, cpaLayout, ensureDir } from "../paths.js";
import { writePidRecord } from "../state.js";
import { sleep } from "../util.js";
import { isProcessAlive } from "./alive.js";
import { inspectRunning, resolveRunning, startDaemon, stopDaemon } from "./lifecycle.js";
import { readProcessStartMarker } from "./pid-identity.js";

const tempHomes: string[] = [];
const childPids: number[] = [];

afterEach(() => {
  for (const pid of childPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-lifecycle-"));
  tempHomes.push(home);
  return home;
}

function spawnLiveChild(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (!child.pid) throw new Error("failed to spawn test process");
  childPids.push(child.pid);
  return child.pid;
}

/** A PID that certainly belongs to no live process (ours, already reaped). */
async function spawnExitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
  if (!child.pid) throw new Error("failed to spawn test process");
  const pid = child.pid;
  await new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  for (let attempt = 0; attempt < 20 && isProcessAlive(pid); attempt++) {
    await sleep(50);
  }
  return pid;
}

/** Recursive `relative/path=content` listing used to prove a home was untouched. */
function snapshotHome(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    const names = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of names) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        entries.push(`${relative}/`);
        walk(full, relative);
      } else {
        entries.push(`${relative}=${fs.readFileSync(full, "utf8")}`);
      }
    }
  };
  walk(root, "");
  return entries;
}

describe("process identity safety", () => {
  it("refuses to stop an alive PID when ownership cannot be verified", async () => {
    const home = tempHome();
    const pid = spawnLiveChild();
    writePidRecord(home, {
      pid,
      exe: "",
      startedAt: new Date().toISOString(),
    });

    await assert.rejects(() => stopDaemon(home), /cannot verify process ownership/);
    assert.equal(isProcessAlive(pid), true);
  });
});

describe("inspectRunning", () => {
  it("never mutates the instance home, unlike resolveRunning", async () => {
    const home = tempHome();
    // Crash residue: only the rollback binary survived the interrupted update.
    fs.writeFileSync(backupExecutablePath(home), "rollback-binary");
    const pid = spawnLiveChild();
    writePidRecord(home, { pid, exe: "", startedAt: new Date().toISOString() });
    const before = snapshotHome(home);

    // The live child is not the managed CPA, so both variants report not-running.
    assert.equal(inspectRunning(home), undefined);
    assert.deepEqual(snapshotHome(home), before);

    assert.equal(resolveRunning(home), undefined);
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "rollback-binary");
    assert.equal(fs.existsSync(cpaLayout(home).pidFile), false);
  });

  it("reports a dead PID without clearing the record", async () => {
    const home = tempHome();
    const pid = await spawnExitedPid();
    assert.equal(isProcessAlive(pid), false);
    writePidRecord(home, { pid, exe: process.execPath, startedAt: new Date().toISOString() });
    const pidFile = cpaLayout(home).pidFile;

    assert.equal(inspectRunning(home), undefined);
    assert.equal(fs.existsSync(pidFile), true);

    assert.equal(resolveRunning(home), undefined);
    assert.equal(fs.existsSync(pidFile), false);
  });
});

/**
 * A spawnable stand-in for the managed CPA binary. On POSIX it records its own
 * PID and stays alive so the test can prove it was terminated; on Windows a real
 * PE image is required, so a copy of node is used and exits on the unknown flag.
 */
function installFakeRuntime(home: string, pidMarker: string): void {
  const exe = activeExecutablePath(home);
  if (process.platform === "win32") {
    fs.copyFileSync(process.execPath, exe);
    return;
  }
  fs.writeFileSync(exe, `#!/bin/sh\necho $$ > ${JSON.stringify(pidMarker)}\nexec sleep 30\n`);
  fs.chmodSync(exe, 0o755);
}

describe("startDaemon", () => {
  it("terminates the new process when its PID record cannot be written", async () => {
    const home = tempHome();
    const layout = cpaLayout(home);
    ensureDir(layout.stateDir);
    fs.writeFileSync(layout.configFile, "port: 8317\n");
    const pidMarker = path.join(home, "child-pid.txt");
    installFakeRuntime(home, pidMarker);

    const originalRename = fs.renameSync;
    fs.renameSync = (from, to): void => {
      if (String(to) === layout.pidFile) {
        const err: NodeJS.ErrnoException = new Error("EPERM: stubbed pid record failure");
        err.code = "EPERM";
        throw err;
      }
      originalRename(from, to);
    };
    try {
      await assert.rejects(
        () => startDaemon(home, { noWait: true }),
        /Started CPA but failed to record its PID; the new process was terminated: /,
      );
    } finally {
      fs.renameSync = originalRename;
    }

    // The Windows stand-in exits on its own, so only POSIX can observe the kill.
    if (process.platform === "win32") return;
    for (let attempt = 0; attempt < 20 && !fs.existsSync(pidMarker); attempt++) {
      await sleep(50);
    }
    if (!fs.existsSync(pidMarker)) return; // Killed before it could run at all.
    const pid = Number(fs.readFileSync(pidMarker, "utf8").trim());
    assert.ok(Number.isInteger(pid) && pid > 0);
    childPids.push(pid);
    for (let attempt = 0; attempt < 20 && isProcessAlive(pid); attempt++) {
      await sleep(50);
    }
    assert.equal(isProcessAlive(pid), false, "the spawned CPA must not be left orphaned");
  });
});

describe("resolveRunning", () => {
  it("verifies a live process by executable path and start marker", async () => {
    const home = tempHome();
    const pid = spawnLiveChild();
    const startMarker = readProcessStartMarker(pid);
    const startedAt = new Date().toISOString();
    writePidRecord(home, { pid, exe: process.execPath, startedAt, startMarker });

    const running = resolveRunning(home);
    assert.equal(running?.pid, pid);
    assert.equal(running?.identityUnknown, false);

    // A start marker recorded for a different process proves PID reuse. Platforms
    // without a readable marker cannot prove it, so there is nothing to assert.
    if (startMarker) {
      writePidRecord(home, { pid, exe: process.execPath, startedAt, startMarker: "bogus:1" });
      assert.equal(resolveRunning(home), undefined);
      assert.equal(fs.existsSync(cpaLayout(home).pidFile), false);
    }
  });
});
