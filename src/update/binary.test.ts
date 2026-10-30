import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { activeExecutablePath, backupExecutablePath } from "../paths.js";
import { RuntimeBinaryTransaction } from "../process/runtime.js";
import { readInstallState, writeInstallState } from "../state.js";
import { silentUpdateReporter } from "./reporter.js";
import {
  BinaryUpdateError,
  checkBinaryUpdate,
  installBinaryPhase,
  type BinaryUpdateDeps,
} from "./binary.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-binary-"));
  temps.push(home);
  return home;
}

function stagedExe(home: string, content: string): string {
  const file = path.join(home, "staged-exe");
  fs.writeFileSync(file, content);
  return file;
}

type DepsOverrides = Partial<BinaryUpdateDeps> & { startFailures?: number };

/** Fake lifecycle deps: never touch real processes. */
function fakeDeps(overrides?: DepsOverrides): BinaryUpdateDeps & { calls: string[] } {
  const calls: string[] = [];
  let remainingStartFailures = overrides?.startFailures ?? 0;
  return {
    calls,
    async stopDaemon(home) {
      calls.push("stop");
      return overrides?.stopDaemon ? overrides.stopDaemon(home) : true;
    },
    async startDaemon(home, options) {
      calls.push("start");
      if (remainingStartFailures > 0) {
        remainingStartFailures -= 1;
        throw new Error("start boom");
      }
      if (overrides?.startDaemon) return overrides.startDaemon(home, options);
      return { pid: 12345, exe: activeExecutablePath(home) };
    },
    async resolveRunning(home) {
      calls.push("resolveRunning");
      return overrides?.resolveRunning ? overrides.resolveRunning(home) : undefined;
    },
  };
}

/** Local test fixture helper: prepares a real transaction and owns discard in finally. */
async function runInstallPhase(
  home: string,
  args: {
    version: string;
    sourceExe: string;
    wasRunning: boolean;
    currentVersion?: string;
  },
  deps: BinaryUpdateDeps = fakeDeps(),
  reporter = silentUpdateReporter,
): Promise<{ restarted: boolean }> {
  const transaction = new RuntimeBinaryTransaction(home);
  try {
    transaction.prepare(args.sourceExe);
    return await installBinaryPhase(
      home,
      {
        version: args.version,
        wasRunning: args.wasRunning,
        currentVersion: args.currentVersion,
        transaction,
      },
      deps,
      reporter,
    );
  } finally {
    transaction.discard();
  }
}

describe("checkBinaryUpdate", () => {
  it("uses health-verified install metadata without executing the active binary", async () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "not a real binary");
    writeInstallState(home, { runtimeVersion: "7.2.92" });

    const result = await checkBinaryUpdate(home, {
      fetchLatestRelease: async () => ({ tag: "v7.2.92" }),
    });

    assert.deepEqual(result, { current: "7.2.92", latest: "7.2.92", upToDate: true });
  });
});

describe("installBinaryPhase", () => {
  it("requires a caller-prepared transaction, does not internally discard it, and commits on success", async () => {
    const home = tempHome();
    const exe = stagedExe(home, "new-binary");
    const transaction = new RuntimeBinaryTransaction(home);
    transaction.prepare(exe);
    assert.ok(fs.existsSync(`${activeExecutablePath(home)}.new`));
    const deps = fakeDeps();

    const result = await installBinaryPhase(
      home,
      {
        version: "2.0.0",
        wasRunning: false,
        transaction,
      },
      deps,
    );

    assert.equal(result.restarted, false);
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "new-binary");
    assert.equal(readInstallState(home).runtimeVersion, "2.0.0");
    transaction.discard();
  });

  it("keeps a half-started binary and its backup intact when recovery cannot stop it", async () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "old");
    let stops = 0;
    let running = false;
    const deps = fakeDeps({
      stopDaemon: async () => {
        if (++stops > 1) throw new Error("stop denied");
        return true;
      },
      startDaemon: async () => {
        running = true;
        throw new Error("not ready");
      },
      resolveRunning: async () =>
        running ? { pid: 12345, exe: activeExecutablePath(home) } : undefined,
    });
    await assert.rejects(
      () =>
        runInstallPhase(
          home,
          {
            version: "2.0.0",
            sourceExe: stagedExe(home, "new"),
            wasRunning: true,
          },
          deps,
        ),
      /stop denied/,
    );
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "new");
    assert.equal(fs.readFileSync(backupExecutablePath(home), "utf8"), "old");
  });

  it("restarts the previous binary even when install metadata stays unwritable", async () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "old");
    writeInstallState(home, { runtimeVersion: "1.0.0" });
    let running = true;
    let starts = 0;
    const deps = fakeDeps({
      stopDaemon: async () => {
        running = false;
        return true;
      },
      startDaemon: async () => {
        starts++;
        running = true;
        return { pid: 12345, exe: activeExecutablePath(home) };
      },
      resolveRunning: async () =>
        running ? { pid: 12345, exe: activeExecutablePath(home) } : undefined,
    });
    const originalOpen = fs.openSync;
    fs.openSync = (file, ...args) => {
      if (String(file).includes(".install.json.") && String(file).endsWith(".tmp")) {
        throw Object.assign(new Error("metadata denied"), { code: "EACCES" });
      }
      return originalOpen(file, ...args);
    };
    try {
      await assert.rejects(
        () =>
          runInstallPhase(
            home,
            {
              version: "2.0.0",
              sourceExe: stagedExe(home, "new"),
              wasRunning: true,
              currentVersion: "1.0.0",
            },
            deps,
          ),
        /metadata denied/,
      );
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(starts, 2);
    assert.equal(running, true);
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "old");
  });

  it("does not restore a stale backup after a failure before replacement", async () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "v2");
    fs.writeFileSync(backupExecutablePath(home), "v1");
    writeInstallState(home, { runtimeVersion: "2.0.0" });

    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (
        String(from) === activeExecutablePath(home) &&
        String(to) === backupExecutablePath(home)
      ) {
        throw new Error("active binary locked");
      }
      return originalRename(from, to);
    };

    try {
      await assert.rejects(
        () =>
          runInstallPhase(
            home,
            {
              version: "3.0.0",
              sourceExe: stagedExe(home, "v3"),
              wasRunning: false,
              currentVersion: "2.0.0",
            },
            fakeDeps(),
          ),
        /active binary locked/,
      );
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "v2");
    assert.equal(readInstallState(home).runtimeVersion, "2.0.0");
  });

  it("installs, records state, and clears the backup when CPA was not running", async () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "old-binary");
    writeInstallState(home, { runtimeVersion: "1.0.0" });
    const deps = fakeDeps();

    const result = await runInstallPhase(
      home,
      {
        version: "2.0.0",
        sourceExe: stagedExe(home, "new-binary"),
        wasRunning: false,
        currentVersion: "1.0.0",
      },
      deps,
      silentUpdateReporter,
    );

    assert.equal(result.restarted, false);
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "new-binary");
    assert.equal(readInstallState(home).runtimeVersion, "2.0.0");
    assert.equal(fs.existsSync(backupExecutablePath(home)), false);
    assert.ok(!deps.calls.includes("stop"));
    assert.ok(!deps.calls.includes("start"));
  });

  it("restarts when CPA was running", async () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "old-binary");
    const deps = fakeDeps();

    const result = await runInstallPhase(
      home,
      {
        version: "2.0.0",
        sourceExe: stagedExe(home, "new-binary"),
        wasRunning: true,
        currentVersion: "1.0.0",
      },
      deps,
      silentUpdateReporter,
    );

    assert.equal(result.restarted, true);
    assert.deepEqual(deps.calls, ["stop", "start"]);
  });

  it("rolls back and restarts the previous binary when the new one fails to start", async () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "old-binary");
    writeInstallState(home, { runtimeVersion: "1.0.0" });
    const deps = fakeDeps({ startFailures: 1 });

    await assert.rejects(
      () =>
        runInstallPhase(
          home,
          {
            version: "2.0.0",
            sourceExe: stagedExe(home, "broken-binary"),
            wasRunning: true,
            currentVersion: "1.0.0",
          },
          deps,
          silentUpdateReporter,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BinaryUpdateError);
        assert.equal(err.previousRestarted, true);
        assert.equal(err.previousRestored, true);
        assert.match(err.message, /previous CLIProxyAPI version was restored and restarted/i);
        return true;
      },
    );

    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "old-binary");
    assert.equal(readInstallState(home).runtimeVersion, "1.0.0");
  });

  it("reports a failed rollback restart", async () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "old-binary");
    writeInstallState(home, { runtimeVersion: "1.0.0" });
    const deps = fakeDeps({ startFailures: 2 });

    await assert.rejects(
      () =>
        runInstallPhase(
          home,
          {
            version: "2.0.0",
            sourceExe: stagedExe(home, "broken-binary"),
            wasRunning: true,
            currentVersion: "1.0.0",
          },
          deps,
          silentUpdateReporter,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BinaryUpdateError);
        assert.equal(err.previousRestarted, false);
        assert.equal(err.previousRestored, true);
        assert.match(err.message, /restored but could not be restarted/i);
        assert.match(err.message, /Restart error/);
        return true;
      },
    );

    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "old-binary");
    assert.equal(readInstallState(home).runtimeVersion, "1.0.0");
  });

  it("never records a version when the backup is missing after a failure", async () => {
    const home = tempHome();
    // No pre-existing binary: install creates no .bak, so rollback has nothing.
    writeInstallState(home, { runtimeVersion: "1.0.0" });
    const deps = fakeDeps({ startFailures: 2 });

    await assert.rejects(
      () =>
        runInstallPhase(
          home,
          {
            version: "2.0.0",
            sourceExe: stagedExe(home, "broken-binary"),
            wasRunning: true,
            currentVersion: "1.0.0",
          },
          deps,
          silentUpdateReporter,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BinaryUpdateError);
        assert.equal(err.previousRestarted, false);
        assert.match(err.message, /No previous CLIProxyAPI executable could be restored/);
        return true;
      },
    );

    assert.equal(readInstallState(home).runtimeVersion, undefined);
  });

  it("restarts CPA and keeps the recorded version when the binary never got replaced", async () => {
    const home = tempHome();
    // Steady state: an intact binary and NO .bak (cleared after the last update).
    fs.writeFileSync(activeExecutablePath(home), "old-binary");
    writeInstallState(home, { runtimeVersion: "7.2.65" });
    const deps = fakeDeps();

    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (
        String(from) === activeExecutablePath(home) &&
        String(to) === backupExecutablePath(home)
      ) {
        throw new Error("CPA binary still locked after retry");
      }
      return originalRename(from, to);
    };

    try {
      await assert.rejects(
        () =>
          runInstallPhase(
            home,
            {
              version: "7.2.66",
              sourceExe: stagedExe(home, "new-binary"),
              wasRunning: true,
              currentVersion: "7.2.65",
            },
            deps,
            silentUpdateReporter,
          ),
        (err: unknown) => {
          assert.ok(err instanceof BinaryUpdateError);
          assert.equal(err.previousRestarted, true);
          // The untouched executable is still on disk, so recovery restarted it in place.
          assert.doesNotMatch(err.message, /could be restored/);
          assert.match(err.message, /existing CLIProxyAPI version was restarted/i);
          assert.match(err.message, /still locked/);
          return true;
        },
      );
    } finally {
      fs.renameSync = originalRename;
    }

    // A transient file lock must not leave CPA stopped…
    assert.ok(deps.calls.includes("start"));
    // …must not touch the binary…
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "old-binary");
    assert.equal(fs.existsSync(backupExecutablePath(home)), false);
    // …and must not wipe the version that binary really is.
    assert.equal(readInstallState(home).runtimeVersion, "7.2.65");
  });

  it("preserves the recorded version when rename fails but rollback keeps the binary", async () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "old-binary");
    writeInstallState(home, { runtimeVersion: "7.2.65" });
    const deps = fakeDeps();

    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (
        String(from) === activeExecutablePath(home) &&
        String(to) === backupExecutablePath(home)
      ) {
        throw new Error("rename failed");
      }
      return originalRename(from, to);
    };

    try {
      await assert.rejects(() =>
        runInstallPhase(
          home,
          {
            version: "7.2.66",
            sourceExe: stagedExe(home, "new-binary"),
            wasRunning: false,
            currentVersion: undefined,
          },
          deps,
          silentUpdateReporter,
        ),
      );
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "old-binary");
    assert.equal(readInstallState(home).runtimeVersion, "7.2.65");
  });

  it("reports a missing backup when a pre-replace failure finds no binary at all", async () => {
    const home = tempHome();
    // No binary on disk and no .bak: nothing to restart, message must say so.
    writeInstallState(home, { runtimeVersion: "7.2.65" });
    const deps = fakeDeps();

    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (String(to) === activeExecutablePath(home)) {
        throw new Error("destination unwritable");
      }
      return originalRename(from, to);
    };

    try {
      await assert.rejects(
        () =>
          runInstallPhase(
            home,
            {
              version: "7.2.66",
              sourceExe: stagedExe(home, "new-binary"),
              wasRunning: true,
              currentVersion: "7.2.65",
            },
            deps,
            silentUpdateReporter,
          ),
        (err: unknown) => {
          assert.ok(err instanceof BinaryUpdateError);
          assert.equal(err.previousRestarted, false);
          assert.match(err.message, /No previous CLIProxyAPI executable could be restored/);
          return true;
        },
      );
    } finally {
      fs.renameSync = originalRename;
    }

    assert.ok(!deps.calls.includes("start"));
    assert.equal(readInstallState(home).runtimeVersion, undefined);
  });

  it("fails preparation without stopping CPA or changing the active binary/state", async () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "old-binary");
    writeInstallState(home, { runtimeVersion: "7.2.65" });
    const deps = fakeDeps();
    await assert.rejects(
      () =>
        runInstallPhase(
          home,
          {
            version: "7.2.66",
            sourceExe: path.join(home, "missing-extracted-exe"),
            wasRunning: true,
            currentVersion: "7.2.65",
          },
          deps,
          silentUpdateReporter,
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          !(error instanceof BinaryUpdateError),
          "nothing stopped, so no restart/rollback claim",
        );
        return true;
      },
    );
    assert.deepEqual(deps.calls, []);
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "old-binary");
    assert.equal(fs.existsSync(backupExecutablePath(home)), false);
    assert.equal(fs.existsSync(`${activeExecutablePath(home)}.new`), false);
    assert.equal(readInstallState(home).runtimeVersion, "7.2.65");
  });
});
