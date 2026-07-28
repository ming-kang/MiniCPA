import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { activeExecutablePath, backupExecutablePath } from "../paths.js";
import { readInstallState, writeInstallState } from "../state.js";
import { silentUpdateReporter } from "./reporter.js";
import { BinaryUpdateError, installBinaryPhase, type BinaryUpdateDeps } from "./binary.js";

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
    resolveRunning(home) {
      calls.push("resolveRunning");
      return overrides?.resolveRunning ? overrides.resolveRunning(home) : undefined;
    },
    async waitForBinaryUnlocked(home) {
      calls.push("waitUnlock");
      if (overrides?.waitForBinaryUnlocked) return overrides.waitForBinaryUnlocked(home);
    },
  };
}

describe("installBinaryPhase", () => {
  it("installs, records state, and clears the backup when CPA was not running", async () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "old-binary");
    writeInstallState(home, { runtimeVersion: "1.0.0" });
    const deps = fakeDeps();

    const result = await installBinaryPhase(
      home,
      {
        version: "2.0.0",
        extractedExe: stagedExe(home, "new-binary"),
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

    const result = await installBinaryPhase(
      home,
      {
        version: "2.0.0",
        extractedExe: stagedExe(home, "new-binary"),
        wasRunning: true,
        currentVersion: "1.0.0",
      },
      deps,
      silentUpdateReporter,
    );

    assert.equal(result.restarted, true);
    assert.deepEqual(deps.calls, ["stop", "waitUnlock", "start"]);
  });

  it("rolls back and restarts the previous binary when the new one fails to start", async () => {
    const home = tempHome();
    fs.writeFileSync(activeExecutablePath(home), "old-binary");
    writeInstallState(home, { runtimeVersion: "1.0.0" });
    const deps = fakeDeps({ startFailures: 1 });

    await assert.rejects(
      () =>
        installBinaryPhase(
          home,
          {
            version: "2.0.0",
            extractedExe: stagedExe(home, "broken-binary"),
            wasRunning: true,
            currentVersion: "1.0.0",
          },
          deps,
          silentUpdateReporter,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BinaryUpdateError);
        assert.equal(err.previousRestarted, true);
        assert.match(err.message, /Previous CPA was restarted/);
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
        installBinaryPhase(
          home,
          {
            version: "2.0.0",
            extractedExe: stagedExe(home, "broken-binary"),
            wasRunning: true,
            currentVersion: "1.0.0",
          },
          deps,
          silentUpdateReporter,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BinaryUpdateError);
        assert.equal(err.previousRestarted, false);
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
        installBinaryPhase(
          home,
          {
            version: "2.0.0",
            extractedExe: stagedExe(home, "broken-binary"),
            wasRunning: true,
            currentVersion: "1.0.0",
          },
          deps,
          silentUpdateReporter,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BinaryUpdateError);
        assert.equal(err.previousRestarted, false);
        assert.match(err.message, /Backup missing/);
        return true;
      },
    );

    // C3 regression: state must not claim a version with no binary on disk.
    assert.equal(readInstallState(home).runtimeVersion, undefined);
  });

  it("restarts CPA and keeps the recorded version when the binary never got replaced", async () => {
    const home = tempHome();
    // Steady state: an intact binary and NO .bak (cleared after the last update).
    fs.writeFileSync(activeExecutablePath(home), "old-binary");
    writeInstallState(home, { runtimeVersion: "7.2.65" });
    const deps = fakeDeps({
      async waitForBinaryUnlocked() {
        throw new Error("CPA binary still locked after 30000ms");
      },
    });

    await assert.rejects(
      () =>
        installBinaryPhase(
          home,
          {
            version: "7.2.66",
            extractedExe: stagedExe(home, "new-binary"),
            wasRunning: true,
            currentVersion: "7.2.65",
          },
          deps,
          silentUpdateReporter,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BinaryUpdateError);
        assert.equal(err.previousRestarted, true);
        // The untouched binary is still on disk, so this is NOT a missing-backup case.
        assert.doesNotMatch(err.message, /Backup missing/);
        assert.match(err.message, /still locked/);
        return true;
      },
    );

    // A transient file lock must not leave CPA stopped…
    assert.ok(deps.calls.includes("start"));
    // …must not touch the binary…
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "old-binary");
    assert.equal(fs.existsSync(backupExecutablePath(home)), false);
    // …and must not wipe the version that binary really is.
    assert.equal(readInstallState(home).runtimeVersion, "7.2.65");
  });

  it("reports a missing backup when a pre-replace failure finds no binary at all", async () => {
    const home = tempHome();
    // No binary on disk and no .bak: nothing to restart, message must say so.
    writeInstallState(home, { runtimeVersion: "7.2.65" });
    const deps = fakeDeps({
      async waitForBinaryUnlocked() {
        throw new Error("CPA binary still locked after 30000ms");
      },
    });

    await assert.rejects(
      () =>
        installBinaryPhase(
          home,
          {
            version: "7.2.66",
            extractedExe: stagedExe(home, "new-binary"),
            wasRunning: true,
            currentVersion: "7.2.65",
          },
          deps,
          silentUpdateReporter,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BinaryUpdateError);
        assert.equal(err.previousRestarted, false);
        assert.match(err.message, /Backup missing/);
        return true;
      },
    );

    assert.ok(!deps.calls.includes("start"));
    assert.equal(readInstallState(home).runtimeVersion, undefined);
  });

  it("restarts CPA when installRuntimeBinary fails before touching the active binary", async () => {
    const home = tempHome();
    // Steady state again: an intact binary and NO .bak. This time the file lock
    // clears and the failure happens INSIDE installRuntimeBinary, while it is
    // still only staging (ENOSPC/EACCES on the copy, an AV lock on the fsync
    // open). The active binary is never moved aside, so no .bak is created.
    fs.writeFileSync(activeExecutablePath(home), "old-binary");
    writeInstallState(home, { runtimeVersion: "7.2.65" });
    const deps = fakeDeps();

    await assert.rejects(
      () =>
        installBinaryPhase(
          home,
          {
            version: "7.2.66",
            // Never created: copyFileSync into the staging name throws ENOENT.
            extractedExe: path.join(home, "extracted-exe-that-does-not-exist"),
            wasRunning: true,
            currentVersion: "7.2.65",
          },
          deps,
          silentUpdateReporter,
        ),
      (err: unknown) => {
        assert.ok(err instanceof BinaryUpdateError);
        assert.equal(err.previousRestarted, true);
        assert.doesNotMatch(err.message, /Backup missing/);
        return true;
      },
    );

    assert.ok(deps.calls.includes("start"), "CPA must be brought back up");
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "old-binary");
    assert.equal(fs.existsSync(backupExecutablePath(home)), false);
    assert.equal(readInstallState(home).runtimeVersion, "7.2.65");
  });
});
