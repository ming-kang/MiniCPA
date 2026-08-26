import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LINGER_HINT, type AutostartState } from "../process/autostart.js";
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
      lingerHint: async () => LINGER_HINT,
    };

    const options = { packageRoot: "/npm/lib/node_modules/@astralyn/minicpa" };
    const first = await captureConsole(() => runAuto(options, deps));
    assert.equal(state, "on");
    assert.deepEqual(first.stdout, ["Autostart on"]);
    assert.deepEqual(first.stderr, [`Note: ${LINGER_HINT}`]);

    const second = await captureConsole(() => runAuto(options, deps));
    assert.equal(state, "off");
    assert.deepEqual(second.stdout, ["Autostart off"]);
    assert.deepEqual(lockCommands, ["auto", "auto"]);
    assert.deepEqual(inspectedRoots, [options.packageRoot]);
  });

  it("repairs a stale registration instead of silently disabling it", async () => {
    let state: AutostartState = "stale";
    let detectionCalled = false;
    const output = await captureConsole(() =>
      runAuto(
        { packageRoot: "/npm/lib/node_modules/@astralyn/minicpa" },
        {
          inspectState: async () => state,
          setEnabled: async (enabled) => {
            assert.equal(enabled, true);
            state = "on";
          },
          withLock: async <T>(_command: string, fn: () => Promise<T>): Promise<T> => fn(),
          detectGlobalInstall: async () => {
            detectionCalled = true;
            return supportedInstall("/npm/lib/node_modules/@astralyn/minicpa");
          },
          lingerHint: async () => undefined,
        },
      ),
    );

    assert.equal(state, "on");
    assert.equal(detectionCalled, true);
    assert.deepEqual(output.stdout, ["Autostart on"]);
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
          lingerHint: async () => undefined,
        },
      ),
    );

    assert.equal(state, "on");
    assert.equal(detectionCalled, true);
    assert.deepEqual(output.stdout, ["Autostart on"]);
  });

  it("prints the shared linger hint after enabling", async () => {
    const packageRoot = "/npm/lib/node_modules/@astralyn/minicpa";
    const deps: AutoCommandDependencies = {
      inspectState: async () => "off",
      setEnabled: async () => {},
      withLock: async <T>(_command: string, fn: () => Promise<T>): Promise<T> => fn(),
      detectGlobalInstall: async () => supportedInstall(packageRoot),
      // The full policy (Linux gating included) lives in autostart.ts; the
      // command only decides whether to show the returned hint.
      lingerHint: async () => LINGER_HINT,
    };
    const output = await captureConsole(() => runAuto({ packageRoot }, deps));
    assert.deepEqual(output.stdout, ["Autostart on"]);
    assert.deepEqual(output.stderr, [`Note: ${LINGER_HINT}`]);
  });

  it("falls back to the real linger policy when a dependency is explicitly undefined", async () => {
    // `deps` is spread from partial objects at call sites, so an explicitly
    // undefined entry must resolve to the real implementation rather than
    // being called as a function.
    const packageRoot = "/npm/lib/node_modules/@astralyn/minicpa";
    const output = await captureConsole(() =>
      runAuto(
        { packageRoot },
        {
          inspectState: async () => "off",
          setEnabled: async () => {},
          withLock: async <T>(_command: string, fn: () => Promise<T>): Promise<T> => fn(),
          detectGlobalInstall: async () => supportedInstall(packageRoot),
          lingerHint: undefined,
        },
      ),
    );
    assert.deepEqual(output.stdout, ["Autostart on"]);
  });

  it("stays quiet when no hint applies", async () => {
    const packageRoot = "/npm/lib/node_modules/@astralyn/minicpa";
    const output = await captureConsole(() =>
      runAuto(
        { packageRoot },
        {
          inspectState: async () => "off",
          setEnabled: async () => {},
          withLock: async <T>(_command: string, fn: () => Promise<T>): Promise<T> => fn(),
          detectGlobalInstall: async () => supportedInstall(packageRoot),
          lingerHint: async () => undefined,
        },
      ),
    );
    assert.deepEqual(output.stdout, ["Autostart on"]);
    assert.deepEqual(output.stderr, []);
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
      lingerHint: async () => undefined,
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
