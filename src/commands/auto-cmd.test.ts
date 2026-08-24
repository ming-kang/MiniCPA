import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureConsole } from "../test-fixtures/test-env.js";
import { runAuto, type AutoCommandDependencies } from "./auto-cmd.js";

describe("runAuto", () => {
  it("toggles autostart on and off", async () => {
    let enabled = false;
    const lockCommands: string[] = [];
    const inspectedRoots: string[] = [];
    const deps: AutoCommandDependencies = {
      isEnabled: async (): Promise<boolean> => enabled,
      setEnabled: async (next: boolean): Promise<void> => {
        enabled = next;
      },
      withLock: async <T>(command: string, fn: () => Promise<T>): Promise<T> => {
        lockCommands.push(command);
        return fn();
      },
      detectGlobalInstall: async (packageRoot, _dependencies, options) => {
        inspectedRoots.push(packageRoot);
        assert.equal(options?.requireWritable, false);
        return {
          supported: true,
          prefix: "/npm",
          globalRoot: "/npm/lib/node_modules",
          expectedPackageRoot: packageRoot,
          npmCommand: "npm",
        };
      },
    };

    const options = { packageRoot: "/npm/lib/node_modules/@astralyn/minicpa" };
    const first = await captureConsole(() => runAuto(options, deps));
    assert.equal(enabled, true);
    assert.deepEqual(first.stdout, ["Autostart on"]);

    const second = await captureConsole(() => runAuto(options, deps));
    assert.equal(enabled, false);
    assert.deepEqual(second.stdout, ["Autostart off"]);
    assert.deepEqual(lockCommands, ["auto", "auto"]);
    assert.deepEqual(inspectedRoots, [options.packageRoot]);
  });

  it("rejects transient installations before enabling autostart", async () => {
    let setCalled = false;
    const deps: AutoCommandDependencies = {
      isEnabled: async () => false,
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
