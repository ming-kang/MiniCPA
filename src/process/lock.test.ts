import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { miniCpaRoot } from "../paths.js";
import {
  inspectMiniCpaLock,
  listLockPreemptResidue,
  preemptLock,
  withMiniCpaLock,
} from "./lock.js";
import { readProcessStartMarker } from "./pid-identity.js";

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
      process.kill(pid, "SIGKILL");
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
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
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
      `${JSON.stringify({
        pid: holderPid,
        command: "start",
        acquiredAt: new Date().toISOString(),
      })}\n`,
    );
    await assert.rejects(
      () => withMiniCpaLock("update", async () => undefined),
      /Another cpa start is running/,
    );
    assert.ok(fs.existsSync(lockPath()));
  });

  it("names the lock file and its age when a live unrelated PID wedges the lock", async () => {
    configureIsolatedAppRoot();
    // A crashed run whose PID was reused after a reboot: alive, no start marker
    // recorded, so reuse can never be proven and the lock stays held forever.
    const holderPid = spawnLiveHolder();
    const acquiredAt = new Date(Date.now() - 90 * 60_000).toISOString();
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(
      lockPath(),
      `${JSON.stringify({ pid: holderPid, command: "update", acquiredAt })}\n`,
    );

    await assert.rejects(
      () => withMiniCpaLock("start", async () => undefined),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.match(message, /Another cpa update is running/);
        assert.ok(
          message.includes(lockPath()),
          `expected the absolute lock path in: ${JSON.stringify(message)}`,
        );
        assert.ok(
          message.includes(acquiredAt),
          `expected the acquiredAt timestamp in: ${JSON.stringify(message)}`,
        );
        assert.ok(
          message.includes("90m ago"),
          `expected the holder age in: ${JSON.stringify(message)}`,
        );
        return true;
      },
    );
    // Fail-closed stance preserved: the lock is still there.
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

  it("excludes a real second process and recovers after it dies", async () => {
    configureIsolatedAppRoot();
    const lockModuleUrl = new URL("./lock.ts", import.meta.url).href;
    const holderScript = [
      `const { withMiniCpaLock } = await import(${JSON.stringify(lockModuleUrl)});`,
      'await withMiniCpaLock("hold", async () => {',
      '  console.log("HELD");',
      "  await new Promise((resolve) => setTimeout(resolve, 30000));",
      "});",
    ].join("\n");

    const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "-e", holderScript], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child.pid) throw new Error("failed to spawn lock holder");
    childPids.push(child.pid);

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`lock holder never reported HELD. stderr: ${stderr}`)),
        20_000,
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("HELD")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`lock holder exited early. stderr: ${stderr}`));
      });
    });

    await assert.rejects(
      () => withMiniCpaLock("update", async () => undefined),
      /Another cpa hold is running/,
    );

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));

    // Dead holder → stale preemption path → acquisition succeeds.
    let ran = false;
    await withMiniCpaLock("update", async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });

  it("preempts a live PID whose start marker no longer matches", async () => {
    configureIsolatedAppRoot();
    const holderPid = spawnLiveHolder();
    // Only meaningful when the platform can produce markers for the holder.
    const currentMarker = readProcessStartMarker(holderPid);
    if (!currentMarker) return;

    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(
      lockPath(),
      `${JSON.stringify({
        pid: holderPid,
        command: "start",
        acquiredAt: new Date().toISOString(),
        startMarker: "bogus-boot:1",
      })}\n`,
    );

    let ran = false;
    await withMiniCpaLock("update", async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });

  it("waits out a fresh empty lock instead of deleting it", async () => {
    configureIsolatedAppRoot();
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), "");

    await assert.rejects(
      () => withMiniCpaLock("update", async () => undefined),
      /after 5 attempts/,
    );
    // The in-progress lock was never unlinked.
    assert.ok(fs.existsSync(lockPath()));
  });

  it("preempts a stale corrupt lock after the grace period", async () => {
    configureIsolatedAppRoot();
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), "not-json");
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath(), past, past);

    let ran = false;
    await withMiniCpaLock("update", async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });
});

function snapshotStateDir(): string {
  const dir = path.dirname(lockPath());
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).sort();
  } catch {
    return "<absent>";
  }
  return entries
    .map((entry) => {
      const target = path.join(dir, entry);
      const stat = fs.statSync(target);
      return `${entry}:${stat.size}:${stat.mtimeMs}:${fs.readFileSync(target, "utf8")}`;
    })
    .join("\n");
}

describe("inspectMiniCpaLock", () => {
  it("reports an absent lock without creating anything", () => {
    configureIsolatedAppRoot();
    const status = inspectMiniCpaLock();
    assert.equal(status.state, "absent");
    assert.equal(status.path, lockPath());
    assert.equal(status.pid, undefined);
    // A pure read must not materialize the state directory.
    assert.equal(fs.existsSync(path.dirname(lockPath())), false);
  });

  it("reports a held lock and leaves the state directory untouched", () => {
    configureIsolatedAppRoot();
    const acquiredAt = new Date(Date.now() - 5 * 60_000).toISOString();
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(
      lockPath(),
      `${JSON.stringify({ pid: process.pid, command: "update", acquiredAt })}\n`,
    );

    const before = snapshotStateDir();
    const status = inspectMiniCpaLock();
    const after = snapshotStateDir();

    assert.equal(status.state, "held");
    assert.equal(status.path, lockPath());
    assert.equal(status.pid, process.pid);
    assert.equal(status.command, "update");
    assert.equal(status.acquiredAt, acquiredAt);
    assert.ok((status.ageMs ?? 0) >= 5 * 60_000);
    assert.equal(status.holderAlive, true);
    assert.equal(after, before);
  });

  it("reports a corrupt lock as unreadable", () => {
    configureIsolatedAppRoot();
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), "not-json");

    const status = inspectMiniCpaLock();
    assert.equal(status.state, "unreadable");
    assert.equal(status.pid, undefined);
    assert.ok(fs.existsSync(lockPath()));
  });
});

describe("listLockPreemptResidue", () => {
  it("finds orphaned preempt files beside the lock", () => {
    configureIsolatedAppRoot();
    const stateDir = path.dirname(lockPath());
    fs.mkdirSync(stateDir, { recursive: true });
    const residue = path.join(stateDir, "cpa.lock.preempt.123.abc");
    fs.writeFileSync(residue, "orphan");
    fs.writeFileSync(lockPath(), "{}");
    fs.writeFileSync(path.join(stateDir, "cpa.pid"), "1");

    assert.deepEqual(listLockPreemptResidue(), [residue]);
  });

  it("returns an empty list when the state directory does not exist", () => {
    configureIsolatedAppRoot();
    assert.deepEqual(listLockPreemptResidue(), []);
    assert.equal(fs.existsSync(path.dirname(lockPath())), false);
  });
});

describe("preemptLock", () => {
  it("restores the lock when content changed since the stale decision", () => {
    configureIsolatedAppRoot();
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    const liveContent = `${JSON.stringify({ pid: process.pid, command: "live" })}\n`;
    fs.writeFileSync(lockPath(), liveContent);

    // Decision was made against different (stale) content.
    const preempted = preemptLock(lockPath(), {
      kind: "unreadable",
      raw: "stale-content-from-earlier-read",
      mtimeMs: 0,
    });

    assert.equal(preempted, false);
    assert.equal(fs.readFileSync(lockPath(), "utf8"), liveContent);
  });

  it("deletes the lock when content matches the stale decision", () => {
    configureIsolatedAppRoot();
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), "stale");

    const preempted = preemptLock(lockPath(), {
      kind: "unreadable",
      raw: "stale",
      mtimeMs: 0,
    });

    assert.equal(preempted, true);
    assert.equal(fs.existsSync(lockPath()), false);
  });
});
