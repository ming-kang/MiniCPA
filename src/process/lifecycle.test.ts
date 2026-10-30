import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, type TestContext } from "node:test";
import { activeExecutablePath, backupExecutablePath, cpaLayout, ensureDir } from "../paths.js";
import { writePidRecord } from "../state.js";
import { sleep } from "../util.js";
import { isProcessAlive } from "./alive.js";
import {
  inspectRunning,
  resolveRunning,
  StartFailure,
  startDaemon,
  stopDaemon,
} from "./lifecycle.js";
import { isTaggedStartMarker, readProcessStartMarker } from "./pid-identity.js";

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

function differentComparableStartMarker(marker: string): string {
  const numericSuffix = /^(.*?)(-?\d+)$/.exec(marker);
  return numericSuffix
    ? `${numericSuffix[1]}${BigInt(numericSuffix[2] ?? "0") + 1n}`
    : `${marker}:different`;
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

  it("refuses to stop an alive PID when executable probe is inconclusive and start marker is legacy/incomparable", async () => {
    const home = tempHome();
    const pid = spawnLiveChild();
    const currentMarker = await readProcessStartMarker(pid);
    if (!currentMarker) return;

    // Cross-generation marker: untagged legacy Darwin marker against tagged Darwin probe,
    // or tagged marker against untagged Windows/Linux probe.
    const incomparableMarker = isTaggedStartMarker(currentMarker)
      ? "Mon Jul  6 05:01:00 2026"
      : "lstart-utc:1783306860";

    writePidRecord(home, {
      pid,
      exe: "",
      startedAt: new Date().toISOString(),
      startMarker: incomparableMarker,
    });

    const running = await resolveRunning(home);
    assert.equal(running?.pid, pid);
    assert.equal(running?.identityUnknown, true);

    await assert.rejects(() => stopDaemon(home), /cannot verify process ownership/);
    assert.equal(isProcessAlive(pid), true);
    assert.equal(fs.existsSync(cpaLayout(home).pidFile), true);
  });

  it("allows stopping an alive PID with a legacy start marker when executable identity matches", async () => {
    const home = tempHome();
    const pid = spawnLiveChild();
    const currentMarker = await readProcessStartMarker(pid);
    if (!currentMarker) return;

    const incomparableMarker = isTaggedStartMarker(currentMarker)
      ? "Mon Jul  6 05:01:00 2026"
      : "lstart-utc:1783306860";

    writePidRecord(home, {
      pid,
      exe: process.execPath,
      startedAt: new Date().toISOString(),
      startMarker: incomparableMarker,
    });

    const running = await resolveRunning(home);
    assert.equal(running?.pid, pid);
    assert.equal(running?.identityUnknown, false);

    const stopped = await stopDaemon(home);
    assert.equal(stopped, true);
    assert.equal(isProcessAlive(pid), false);
  });

  it("verifies ownership by start marker alone when executable identity is inconclusive but marker matches", async () => {
    const home = tempHome();
    const pid = spawnLiveChild();
    const startMarker = await readProcessStartMarker(pid);
    if (!startMarker) return;

    writePidRecord(home, {
      pid,
      exe: "",
      startedAt: new Date().toISOString(),
      startMarker,
    });

    const running = await resolveRunning(home);
    assert.equal(running?.pid, pid);
    assert.equal(running?.identityUnknown, false);

    const stopped = await stopDaemon(home);
    assert.equal(stopped, true);
    assert.equal(isProcessAlive(pid), false);
  });
});

type FakeProcess = {
  home: string;
  pid: number;
  alive: boolean;
  ticks?: string;
  probes: number;
  signals: string[];
};

/** Exercise POSIX signalling on every runner without sending a signal to any real PID. */
function mockPosixProcess(
  t: TestContext,
  onSignal: (signal: string, state: FakeProcess) => void,
): FakeProcess {
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  t.after(() =>
    Object.defineProperty(process, "platform", { value: platform, configurable: true }),
  );
  const state: FakeProcess = {
    home: tempHome(),
    pid: 424242,
    alive: true,
    ticks: "100",
    probes: 0,
    signals: [],
  };
  writePidRecord(state.home, {
    pid: state.pid,
    exe: process.execPath,
    startedAt: "",
    startMarker: "test-boot:100",
  });
  const kill = process.kill;
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (pid !== state.pid) return kill(pid, signal);
    if (signal === 0) {
      if (state.alive) return true;
      throw Object.assign(new Error("process exited"), { code: "ESRCH" });
    }
    const name = String(signal);
    state.signals.push(name);
    onSignal(name, state);
    return true;
  });
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", ((file, ...args) => {
    if (String(file) === `/proc/${state.pid}/stat`) {
      state.probes++;
      const fields = Array<string>(20).fill("0");
      fields[19] = state.ticks ?? "unreadable";
      return `${state.pid} (test) ${fields.join(" ")}`;
    }
    if (String(file) === "/proc/sys/kernel/random/boot_id") return "test-boot";
    return read(file, ...args);
  }) as typeof fs.readFileSync);
  const readlink = fs.readlinkSync;
  t.mock.method(fs, "readlinkSync", ((file, ...args) =>
    String(file) === `/proc/${state.pid}/exe`
      ? process.execPath
      : Reflect.apply(readlink, fs, [file, ...args])) as typeof fs.readlinkSync);
  let clock = 0;
  t.mock.method(Date, "now", () => {
    clock += 6000;
    return clock;
  });
  return state;
}

describe("stopDaemon phases", () => {
  it("does not force-kill a process that exits gracefully", async (t) => {
    const state = mockPosixProcess(t, (_signal, current) => {
      current.alive = false;
    });
    assert.equal(await stopDaemon(state.home), true);
    assert.deepEqual(state.signals, ["SIGTERM"]);
    assert.equal(state.probes, 2, "ownership is checked again just before the first signal");
    assert.equal(fs.existsSync(cpaLayout(state.home).pidFile), false);
  });

  it("rechecks ownership before force-killing after the grace deadline", async (t) => {
    const state = mockPosixProcess(t, (signal, current) => {
      if (signal === "SIGKILL") current.alive = false;
    });
    assert.equal(await stopDaemon(state.home), true);
    assert.deepEqual(state.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(state.probes, 3, "the force signal needs its own fresh identity snapshot");
  });

  it("refuses force-kill and keeps the record if the identity marker degrades", async (t) => {
    const state = mockPosixProcess(t, (_signal, current) => {
      current.ticks = undefined;
    });
    await assert.rejects(() => stopDaemon(state.home), /can no longer verify/);
    assert.deepEqual(state.signals, ["SIGTERM"]);
    assert.equal(state.alive, true);
    assert.equal(fs.existsSync(cpaLayout(state.home).pidFile), true);
  });

  it("keeps the record when the process survives both stopping phases", async (t) => {
    const state = mockPosixProcess(t, () => {});
    await assert.rejects(() => stopDaemon(state.home), /still running after stop/);
    assert.deepEqual(state.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(fs.existsSync(cpaLayout(state.home).pidFile), true);
  });

  it("tolerates ESRCH when the process exits just before the graceful signal", async (t) => {
    const state = mockPosixProcess(t, (_signal, current) => {
      current.alive = false;
      throw Object.assign(new Error("process exited"), { code: "ESRCH" });
    });
    assert.equal(await stopDaemon(state.home), true);
    assert.deepEqual(state.signals, ["SIGTERM"]);
  });

  it("propagates other signal errors without clearing the record", async (t) => {
    const failure = Object.assign(new Error("signal denied"), { code: "EPERM" });
    const state = mockPosixProcess(t, () => {
      throw failure;
    });
    await assert.rejects(
      () => stopDaemon(state.home),
      (error) => error === failure,
    );
    assert.deepEqual(state.signals, ["SIGTERM"]);
    assert.equal(fs.existsSync(cpaLayout(state.home).pidFile), true);
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
    assert.equal(await inspectRunning(home), undefined);
    assert.deepEqual(snapshotHome(home), before);

    assert.equal(await resolveRunning(home), undefined);
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "rollback-binary");
    assert.equal(fs.existsSync(cpaLayout(home).pidFile), false);
  });

  it("reports a dead PID without clearing the record", async () => {
    const home = tempHome();
    const pid = await spawnExitedPid();
    assert.equal(isProcessAlive(pid), false);
    writePidRecord(home, { pid, exe: process.execPath, startedAt: new Date().toISOString() });
    const pidFile = cpaLayout(home).pidFile;

    assert.equal(await inspectRunning(home), undefined);
    assert.equal(fs.existsSync(pidFile), true);

    assert.equal(await resolveRunning(home), undefined);
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

describe("StartFailure", () => {
  it("quotes only what this start wrote and summarizes its last line", () => {
    const home = tempHome();
    const layout = cpaLayout(home);
    ensureDir(layout.logsDir);
    fs.writeFileSync(layout.runtimeLogFile, "[t0] [--------] [info ] [main.go:1] previous run\n");
    const since = fs.statSync(layout.runtimeLogFile).size;
    fs.appendFileSync(
      layout.runtimeLogFile,
      "[t1] [--------] [info ] [main.go:1] starting\n[t2] [--------] [error] [run.go:66] bind: address in use\n",
    );

    const failure = new StartFailure(home, "CLIProxyAPI exited immediately.", since);
    assert.equal(
      failure.message,
      [
        "CLIProxyAPI exited immediately.",
        "--- main.log ---",
        "[t1] [--------] [info ] [main.go:1] starting",
        "[t2] [--------] [error] [run.go:66] bind: address in use",
        `Full log: ${layout.runtimeLogFile}`,
      ].join("\n"),
    );
    assert.equal(failure.summary, "CLIProxyAPI exited immediately. bind: address in use");
  });

  it("treats a rotated log as entirely new and omits an empty excerpt", () => {
    const home = tempHome();
    const layout = cpaLayout(home);
    ensureDir(layout.logsDir);
    const missing = new StartFailure(home, "CLIProxyAPI exited immediately.", 0);
    assert.equal(
      missing.message,
      `CLIProxyAPI exited immediately.\nFull log: ${layout.runtimeLogFile}`,
    );
    assert.equal(missing.summary, "CLIProxyAPI exited immediately.");

    fs.writeFileSync(layout.runtimeLogFile, "fatal: bad config\n");
    const rotated = new StartFailure(home, "CLIProxyAPI exited immediately.", 1_000_000);
    assert.match(rotated.message, /--- main\.log ---\nfatal: bad config\n/);
    assert.equal(rotated.summary, "CLIProxyAPI exited immediately. fatal: bad config");
  });
});

describe("startDaemon", () => {
  it("creates logs/ before spawning and does not capture detached stdout/stderr", async () => {
    const home = tempHome();
    const layout = cpaLayout(home);
    fs.writeFileSync(layout.configFile, "port: 8317\n");
    if (process.platform === "win32") installFakeRuntime(home, path.join(home, "pid-marker"));
    else {
      fs.writeFileSync(
        activeExecutablePath(home),
        "#!/bin/sh\necho console-output\necho console-error >&2\nexec sleep 30\n",
      );
      fs.chmodSync(activeExecutablePath(home), 0o755);
    }
    try {
      const running = await startDaemon(home, { noWait: true });
      childPids.push(running.pid);
    } catch (error) {
      assert.match(String(error), /exited immediately/);
    }
    // Without ./logs CPA silently writes to <auth-dir>/logs instead.
    assert.ok(fs.statSync(layout.logsDir).isDirectory());
    assert.deepEqual(fs.readdirSync(layout.logsDir), []);
  });

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
        /CLIProxyAPI started, but MiniCPA could not record its PID; the new process was terminated: /,
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
    const startMarker = await readProcessStartMarker(pid);
    const startedAt = new Date().toISOString();
    writePidRecord(home, { pid, exe: process.execPath, startedAt, startMarker });

    const running = await resolveRunning(home);
    assert.equal(running?.pid, pid);
    assert.equal(running?.identityUnknown, false);

    // A start marker recorded for a different process proves PID reuse. Platforms
    // without a readable marker cannot prove it, so there is nothing to assert.
    if (startMarker) {
      writePidRecord(home, {
        pid,
        exe: process.execPath,
        startedAt,
        startMarker: differentComparableStartMarker(startMarker),
      });
      assert.equal(await resolveRunning(home), undefined);
      assert.equal(fs.existsSync(cpaLayout(home).pidFile), false);
    }
  });
});
