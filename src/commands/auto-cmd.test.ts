import { LINGER_HINT } from "../process/autostart-linux.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { activeExecutablePath, cpaLayout, ensureDir, resolveCpaHome } from "../paths.js";
import type { AutostartState } from "../process/autostart.js";
import { captureConsole } from "../test-fixtures/test-env.js";
import { runAuto, startPreconditionNotes, type AutoCommandDependencies } from "./auto-cmd.js";

function supportedInstall(packageRoot: string) {
  return {
    supported: true as const,
    prefix: "/npm",
    globalRoot: "/npm/lib/node_modules",
    expectedPackageRoot: packageRoot,
    npmCommand: "npm" as const,
  };
}

/**
 * Keep these tests off the real instance home: the precondition probe reads
 * `config.yaml` and the managed binary, so the default implementation would make
 * stderr depend on whatever the developer's machine happens to have installed.
 */
const noPreconditionNotes = (): string[] => [];

const packageRoot = "/npm/lib/node_modules/@astralyn/minicpa";
const lockedOut = async <T>(): Promise<T> => {
  throw new Error("showing the state must not take the lock");
};
const unlocked = async <T>(_command: string, fn: () => Promise<T>): Promise<T> => fn();

describe("runAuto", () => {
  it("shows the current state without taking the lock or changing it", async () => {
    const expected: Record<AutostartState, string> = {
      on: "Autostart    on",
      off: "Autostart    off",
      stale: "Autostart    stale (registered for a different MiniCPA launcher — run: cpa auto on)",
      disabled: "Autostart    disabled by the OS (run: cpa auto on)",
    };
    for (const [state, line] of Object.entries(expected) as [AutostartState, string][]) {
      const output = await captureConsole(() =>
        runAuto(
          { packageRoot },
          {
            inspectState: async () => state,
            setEnabled: async () => {
              throw new Error("showing the state must not change it");
            },
            withLock: lockedOut,
            detectGlobalInstall: async () => {
              throw new Error("showing the state must not inspect the installation");
            },
            lingerHint: async () => undefined,
            preconditionNotes: noPreconditionNotes,
          },
        ),
      );
      assert.deepEqual(output.stdout, [line]);
      assert.deepEqual(output.stderr, []);
    }
  });

  it("still reports missing preconditions when showing an active registration", async () => {
    const output = await captureConsole(() =>
      runAuto(
        { packageRoot },
        {
          inspectState: async () => "on",
          withLock: lockedOut,
          lingerHint: async () => undefined,
          preconditionNotes: () => ["no config.yaml yet — run: cpa init"],
        },
      ),
    );
    assert.deepEqual(output.stdout, ["Autostart    on"]);
    assert.deepEqual(output.stderr, ["Note: no config.yaml yet — run: cpa init"]);
  });

  it("sets on and off under the lock and checks the installation only when enabling", async () => {
    let state: AutostartState = "off";
    const lockCommands: string[] = [];
    const inspectedRoots: string[] = [];
    const deps: AutoCommandDependencies = {
      inspectState: async () => {
        throw new Error("an explicit mode needs no inspection");
      },
      setEnabled: async (next: boolean): Promise<void> => {
        state = next ? "on" : "off";
      },
      withLock: async <T>(command: string, fn: () => Promise<T>): Promise<T> => {
        lockCommands.push(command);
        return fn();
      },
      detectGlobalInstall: async (root, _dependencies, options) => {
        inspectedRoots.push(root);
        assert.equal(options?.requireWritable, false);
        return supportedInstall(root);
      },
      lingerHint: async () => LINGER_HINT,
      preconditionNotes: noPreconditionNotes,
    };

    const first = await captureConsole(() => runAuto({ packageRoot, mode: "on" }, deps));
    assert.equal(state, "on");
    assert.deepEqual(first.stdout, ["Autostart    on"]);
    assert.deepEqual(first.stderr, [`Note: ${LINGER_HINT}`]);

    const second = await captureConsole(() => runAuto({ packageRoot, mode: "off" }, deps));
    assert.equal(state, "off");
    assert.deepEqual(second.stdout, ["Autostart    off"]);
    assert.deepEqual(second.stderr, []);
    assert.deepEqual(lockCommands, ["auto", "auto"]);
    assert.deepEqual(inspectedRoots, [packageRoot]);
  });

  it("is idempotent for repeated explicit modes", async () => {
    const changes: boolean[] = [];
    const deps: AutoCommandDependencies = {
      setEnabled: async (enabled) => {
        changes.push(enabled);
      },
      withLock: unlocked,
      detectGlobalInstall: async () => supportedInstall(packageRoot),
      lingerHint: async () => undefined,
      preconditionNotes: noPreconditionNotes,
    };

    for (const mode of ["on", "on", "off", "off"] as const) {
      await captureConsole(() => runAuto({ packageRoot, mode }, deps));
    }
    assert.deepEqual(changes, [true, true, false, false]);
  });

  it("falls back to the real linger policy when a dependency is explicitly undefined", async () => {
    // `deps` is spread from partial objects at call sites, so an explicitly
    // undefined entry must resolve to the real implementation rather than
    // being called as a function.
    const output = await captureConsole(() =>
      runAuto(
        { packageRoot, mode: "on" },
        {
          setEnabled: async () => {},
          withLock: unlocked,
          detectGlobalInstall: async () => supportedInstall(packageRoot),
          lingerHint: undefined,
          preconditionNotes: noPreconditionNotes,
        },
      ),
    );
    assert.deepEqual(output.stdout, ["Autostart    on"]);
  });

  it("rejects transient installations before enabling autostart", async () => {
    let setCalled = false;
    const deps: AutoCommandDependencies = {
      setEnabled: async () => {
        setCalled = true;
      },
      withLock: unlocked,
      detectGlobalInstall: async () => ({
        supported: false,
        reason: "npx",
        message: "npx cache installations are not stable.",
      }),
    };

    await assert.rejects(
      () => runAuto({ packageRoot: "/tmp/_npx/package", mode: "on" }, deps),
      /Autostart requires a stable direct npm-global MiniCPA installation/,
    );
    assert.equal(setCalled, false);
  });

  it("notes the preconditions a login start would still be missing", async () => {
    const base: AutoCommandDependencies = {
      setEnabled: async () => {},
      withLock: unlocked,
      detectGlobalInstall: async () => supportedInstall(packageRoot),
      lingerHint: async () => undefined,
    };

    // Registering still succeeds: `cpa auto on` before `cpa init` is a legitimate
    // order, and the note is what keeps the gap from surfacing only at next login.
    const enabling = await captureConsole(() =>
      runAuto(
        { packageRoot, mode: "on" },
        { ...base, preconditionNotes: () => ["no config.yaml yet — run: cpa init"] },
      ),
    );
    assert.deepEqual(enabling.stdout, ["Autostart    on"]);
    assert.deepEqual(enabling.stderr, ["Note: no config.yaml yet — run: cpa init"]);

    // Preconditions come before the linger hint, which is the less urgent of the two.
    const both = await captureConsole(() =>
      runAuto(
        { packageRoot, mode: "on" },
        {
          ...base,
          lingerHint: async () => LINGER_HINT,
          preconditionNotes: () => ["no CLIProxyAPI binary yet — run: cpa update"],
        },
      ),
    );
    assert.deepEqual(both.stderr, [
      "Note: no CLIProxyAPI binary yet — run: cpa update",
      `Note: ${LINGER_HINT}`,
    ]);
  });

  it("never probes preconditions while turning autostart off", async () => {
    let probed = false;
    const output = await captureConsole(() =>
      runAuto(
        { packageRoot, mode: "off" },
        {
          setEnabled: async () => {},
          withLock: unlocked,
          detectGlobalInstall: async () => supportedInstall(packageRoot),
          lingerHint: async () => LINGER_HINT,
          preconditionNotes: () => {
            probed = true;
            return ["should never be reported"];
          },
        },
      ),
    );

    assert.equal(probed, false);
    assert.deepEqual(output.stdout, ["Autostart    off"]);
    assert.deepEqual(output.stderr, []);
  });
});

describe("startPreconditionNotes", () => {
  it("reports a missing config and a missing binary, then goes quiet once both exist", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-auto-cmd-"));
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const originalXdgDataHome = process.env.XDG_DATA_HOME;
    const originalHome = process.env.HOME;
    const originalCpaHome = process.env.CPA_HOME;
    process.env.LOCALAPPDATA = base;
    process.env.XDG_DATA_HOME = base;
    process.env.HOME = base;
    delete process.env.CPA_HOME;

    try {
      const home = resolveCpaHome();
      ensureDir(home);

      assert.deepEqual(startPreconditionNotes(), [
        "no config.yaml yet, so a login start would fail — run: cpa init",
        "no CLIProxyAPI binary yet, so a login start would fail — run: cpa update",
      ]);

      fs.writeFileSync(cpaLayout(home).configFile, "port: 8317\n");
      assert.deepEqual(startPreconditionNotes(), [
        "no CLIProxyAPI binary yet, so a login start would fail — run: cpa update",
      ]);

      fs.writeFileSync(activeExecutablePath(home), "binary");
      assert.deepEqual(startPreconditionNotes(), []);
    } finally {
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
      if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdgDataHome;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalCpaHome === undefined) delete process.env.CPA_HOME;
      else process.env.CPA_HOME = originalCpaHome;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
