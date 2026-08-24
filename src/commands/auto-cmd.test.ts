import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AutostartState } from "../process/autostart.js";
import { captureConsole } from "../test-fixtures/test-env.js";
import { runAuto, type AutoCommandDependencies } from "./auto-cmd.js";

function supportedInstall(packageRoot: string) {
  return {
    supported: true as const,
    prefix: "/npm",
    globalRoot: "/npm/lib/node_modules",
    expectedPackageRoot: packageRoot,
    npmCommand: "npm" as const,
  };
}

describe("runAuto", () => {
  it("toggles an absent registration on and an active registration off", async () => {
    let state: AutostartState = "off";
    const lockCommands: string[] = [];
    const inspectedRoots: string[] = [];
    const deps: AutoCommandDependencies = {
      inspectState: async (): Promise<AutostartState> => state,
      setEnabled: async (next: boolean): Promise<void> => {
        state = next ? "on" : "off";
      },
      withLock: async <T>(command: string, fn: () => Promise<T>): Promise<T> => {
        lockCommands.push(command);
        return fn();
      },
      detectGlobalInstall: async (packageRoot, _dependencies, options) => {
        inspectedRoots.push(packageRoot);
        assert.equal(options?.requireWritable, false);
        return supportedInstall(packageRoot);
      },
    };

    const options = { packageRoot: "/npm/lib/node_modules/@astralyn/minicpa" };
    const first = await captureConsole(() => runAuto(options, deps));
    assert.equal(state, "on");
    assert.deepEqual(first.stdout, ["Autostart on"]);

    const second = await captureConsole(() => runAuto(options, deps));
    assert.equal(state, "off");
    assert.deepEqual(second.stdout, ["Autostart off"]);
    assert.deepEqual(lockCommands, ["auto", "auto"]);
    assert.deepEqual(inspectedRoots, [options.packageRoot]);
  });

  it("removes a stale registration instead of accidentally repairing it", async () => {
    let state: AutostartState = "stale";
    let detectionCalled = false;
    const output = await captureConsole(() =>
      runAuto(
        { packageRoot: "/npm/lib/node_modules/@astralyn/minicpa" },
        {
          inspectState: async () => state,
          setEnabled: async (enabled) => {
            assert.equal(enabled, false);
            state = "off";
          },
          withLock: async <T>(_command: string, fn: () => Promise<T>): Promise<T> => fn(),
          detectGlobalInstall: async () => {
            detectionCalled = true;
            return supportedInstall("/npm/lib/node_modules/@astralyn/minicpa");
          },
        },
      ),
    );

    assert.equal(state, "off");
    assert.equal(detectionCalled, false);
    assert.deepEqual(output.stdout, ["Autostart off"]);
  });

  it("re-enables an OS-disabled registration on an argument-free toggle", async () => {
    let state: AutostartState = "disabled";
    let detectionCalled = false;
    const packageRoot = "/npm/lib/node_modules/@astralyn/minicpa";
    const output = await captureConsole(() =>
      runAuto(
        { packageRoot },
        {
          inspectState: async () => state,
          setEnabled: async (enabled) => {
            assert.equal(enabled, true);
            state = "on";
          },
          withLock: async <T>(_command: string, fn: () => Promise<T>): Promise<T> => fn(),
          detectGlobalInstall: async () => {
            detectionCalled = true;
            return supportedInstall(packageRoot);
          },
        },
      ),
    );

    assert.equal(state, "on");
    assert.equal(detectionCalled, true);
    assert.deepEqual(output.stdout, ["Autostart on"]);
  });

  it("supports deterministic explicit on/off without requiring inspection", async () => {
    let state: AutostartState = "disabled";
    const changes: boolean[] = [];
    const packageRoot = "/npm/lib/node_modules/@astralyn/minicpa";
    const deps: AutoCommandDependencies = {
      inspectState: async () => {
        throw new Error("inspection unavailable");
      },
      setEnabled: async (enabled) => {
        changes.push(enabled);
        state = enabled ? "on" : "off";
      },
      withLock: async <T>(_command: string, fn: () => Promise<T>): Promise<T> => fn(),
      detectGlobalInstall: async () => supportedInstall(packageRoot),
    };

    await captureConsole(() => runAuto({ packageRoot, mode: "on" }, deps));
    await captureConsole(() => runAuto({ packageRoot, mode: "on" }, deps));
    await captureConsole(() => runAuto({ packageRoot, mode: "off" }, deps));
    await captureConsole(() => runAuto({ packageRoot, mode: "off" }, deps));

    assert.deepEqual(changes, [true, true, false, false]);
    assert.equal(state, "off");
  });

  it("rejects transient installations before enabling autostart", async () => {
    let setCalled = false;
    const deps: AutoCommandDependencies = {
      inspectState: async () => "off",
      setEnabled: async () => {
        setCalled = true;
      },
      withLock: async <T>(_command: string, fn: () => Promise<T>): Promise<T> => fn(),
      detectGlobalInstall: async () => ({
        supported: false,
        reason: "npx",
        message: "npx cache installations are not stable.",
      }),
    };

    await assert.rejects(
      () => runAuto({ packageRoot: "/tmp/_npx/package" }, deps),
      /Autostart requires a stable direct npm-global MiniCPA installation/,
    );
    assert.equal(setCalled, false);
  });
});
