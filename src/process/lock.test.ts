import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { miniCpaRoot } from "../paths.js";
import { inspectMiniCpaLock, withMiniCpaLock } from "./lock.js";

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
  it("keeps ownership even if the diagnostic lock file disappears", async () => {
    configureIsolatedAppRoot();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holding = withMiniCpaLock("first", async () => {
      fs.unlinkSync(lockPath());
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    try {
      await assert.rejects(() => withMiniCpaLock("second", async () => undefined), /lock lease/);
    } finally {
      release();
      await holding;
    }
  });

  it("does not treat unrelated concurrent tasks as reentrant owners", async () => {
    configureIsolatedAppRoot();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holding = withMiniCpaLock("first", async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    try {
      await assert.rejects(
        () => withMiniCpaLock("second", async () => undefined),
        /Another cpa first is running|lock lease/i,
      );
    } finally {
      release();
      await holding;
    }
  });

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

  it("records diagnostic metadata without start marker while held", async () => {
    configureIsolatedAppRoot();
    await withMiniCpaLock("test-cmd", async () => {
      const raw = fs.readFileSync(lockPath(), "utf8");
      const record = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(record.pid, process.pid);
      assert.equal(record.command, "test-cmd");
      assert.ok(typeof record.acquiredAt === "string");
      assert.equal(record.startMarker, undefined);
    });
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
      child.once("exit", async () => {
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

    // Dead holder → lease crash-released by OS → acquisition succeeds.
    let ran = false;
    await withMiniCpaLock("update", async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });

  it("does not block when an obsolete stale-PID diagnostic file exists", async () => {
    configureIsolatedAppRoot();
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(
      lockPath(),
      `${JSON.stringify({ pid: 999_999_999, command: "stale", acquiredAt: new Date().toISOString() })}\n`,
    );
    let ran = false;
    await withMiniCpaLock("test", async () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.equal(fs.existsSync(lockPath()), false);
  });

  it("does not block when an obsolete diagnostic file contains a live PID without a lease", async () => {
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

    let ran = false;
    await withMiniCpaLock("update", async () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.equal(fs.existsSync(lockPath()), false);
  });

  it("does not block when an empty diagnostic lock file exists", async () => {
    configureIsolatedAppRoot();
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), "");

    let ran = false;
    await withMiniCpaLock("update", async () => {
      ran = true;
    });

    assert.equal(ran, true);
    assert.equal(fs.existsSync(lockPath()), false);
  });

  it("does not block when a corrupt diagnostic lock file exists", async () => {
    configureIsolatedAppRoot();
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), "not-json");

    let ran = false;
    await withMiniCpaLock("update", async () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.equal(fs.existsSync(lockPath()), false);
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
  it("reports an absent lock without creating anything", async () => {
    configureIsolatedAppRoot();
    const status = inspectMiniCpaLock();
    assert.equal(status.state, "absent");
    assert.equal(status.path, lockPath());
    assert.equal(fs.existsSync(path.dirname(lockPath())), false);
  });

  it("reports a record and leaves the state directory untouched", async () => {
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

    assert.equal(status.state, "record");
    assert.equal(status.path, lockPath());
    if (status.state === "record") {
      assert.equal(status.pid, process.pid);
      assert.equal(status.command, "update");
      assert.equal(status.acquiredAt, acquiredAt);
      assert.ok((status.ageMs ?? 0) >= 5 * 60_000);
      assert.equal(status.holderAlive, true);
    }
    assert.equal(after, before);
  });

  it("reports a corrupt lock as unreadable", async () => {
    configureIsolatedAppRoot();
    fs.mkdirSync(path.dirname(lockPath()), { recursive: true });
    fs.writeFileSync(lockPath(), "not-json");

    const status = inspectMiniCpaLock();
    assert.equal(status.state, "unreadable");
    assert.equal(status.path, lockPath());
    assert.ok(fs.existsSync(lockPath()));
  });
});
