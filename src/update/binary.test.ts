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
      { version: "2.0.0", extractedExe: stagedExe(home, "new-binary"), wasRunning: false, currentVersion: "1.0.0" },
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
      { version: "2.0.0", extractedExe: stagedExe(home, "new-binary"), wasRunning: true, currentVersion: "1.0.0" },
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
          { version: "2.0.0", extractedExe: stagedExe(home, "broken-binary"), wasRunning: true, currentVersion: "1.0.0" },
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
          { version: "2.0.0", extractedExe: stagedExe(home, "broken-binary"), wasRunning: true, currentVersion: "1.0.0" },
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
          { version: "2.0.0", extractedExe: stagedExe(home, "broken-binary"), wasRunning: true, currentVersion: "1.0.0" },
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
});
