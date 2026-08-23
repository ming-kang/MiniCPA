import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { withCliErrors } from "../cli-errors.js";
import { compareMinicpaVersions } from "../update/minicpa-release.js";
import type { SupportedNpmGlobalInstall } from "../update/self-upgrade.js";
import {
  runUpgrade,
  runUpgradeCheck,
  type UpgradeCheckDeps,
  type UpgradeDeps,
} from "./upgrade-cmd.js";

const savedExitCode = process.exitCode;

const supportedDetection: SupportedNpmGlobalInstall = {
  supported: true,
  prefix: "/npm",
  globalRoot: "/npm/lib/node_modules",
  expectedPackageRoot: "/npm/lib/node_modules/@astralyn/minicpa",
  npmCommand: "npm",
};

function upgradeDeps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    fetchLatestMinicpaVersion: async () => "1.1.0",
    compareMinicpaVersions,
    detectNpmGlobalInstall: async () => supportedDetection,
    installMinicpaVersion: async () => undefined,
    updateMinicpaVersion: async () => undefined,
    withMiniCpaLock: async <T>(_command: string, fn: () => Promise<T>) => await fn(),
    ...overrides,
  };
}

async function captureOutput<T>(fn: () => Promise<T>): Promise<{
  stdout: string;
  stderr: string;
  result: T;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => stdout.push(String(message));
  console.error = (message?: unknown) => stderr.push(String(message));
  try {
    const result = await fn();
    return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), result };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

afterEach(() => {
  process.exitCode = savedExitCode;
});

describe("runUpgrade", () => {
  it("does nothing when MiniCPA is current without --force", async () => {
    let installationInspected = false;
    let lockCalled = false;
    const deps = upgradeDeps({
      fetchLatestMinicpaVersion: async () => "1.1.0",
      detectNpmGlobalInstall: async () => {
        installationInspected = true;
        return supportedDetection;
      },
      withMiniCpaLock: async <T>(_command: string, fn: () => Promise<T>) => {
        lockCalled = true;
        return await fn();
      },
    });

    const { stdout } = await captureOutput(() =>
      runUpgrade({ currentVersion: "1.1.0", packageRoot: "/package" }, deps),
    );

    assert.equal(lockCalled, false);
    assert.equal(installationInspected, false);
    assert.equal(stdout, "MiniCPA is already up to date (1.1.0)");
  });

  it("upgrades an outdated version with npm update while locked", async () => {
    const events: string[] = [];
    const deps = upgradeDeps({
      fetchLatestMinicpaVersion: async () => {
        events.push("fetch");
        return "1.1.0";
      },
      detectNpmGlobalInstall: async (packageRoot) => {
        assert.equal(packageRoot, "/package");
        events.push("detect");
        return supportedDetection;
      },
      updateMinicpaVersion: async (detection, version) => {
        assert.equal(detection, supportedDetection);
        assert.equal(version, "1.1.0");
        events.push("update");
      },
      installMinicpaVersion: async () => assert.fail("normal upgrades must use npm update"),
      withMiniCpaLock: async <T>(command: string, fn: () => Promise<T>) => {
        assert.equal(command, "upgrade");
        events.push("lock-enter");
        const result = await fn();
        events.push("lock-exit");
        return result;
      },
    });

    const { stdout } = await captureOutput(() =>
      runUpgrade({ currentVersion: "1.0.0", packageRoot: "/package" }, deps),
    );

    assert.deepEqual(events, ["fetch", "lock-enter", "detect", "update", "lock-exit"]);
    assert.equal(
      stdout,
      [
        "MiniCPA upgrade available: 1.0.0 → 1.1.0",
        "Upgrading MiniCPA with npm…",
        "MiniCPA upgraded: 1.0.0 → 1.1.0",
      ].join("\n"),
    );
  });

  it("reinstalls latest when current and --force is supplied", async () => {
    let installed = 0;
    const deps = upgradeDeps({
      fetchLatestMinicpaVersion: async () => "1.1.0",
      installMinicpaVersion: async (detection, version) => {
        assert.equal(detection, supportedDetection);
        assert.equal(version, "1.1.0");
        installed += 1;
      },
      updateMinicpaVersion: async () => assert.fail("--force must use exact-version install"),
    });

    const { stdout } = await captureOutput(() =>
      runUpgrade({ currentVersion: "1.1.0", packageRoot: "/package", force: true }, deps),
    );

    assert.equal(installed, 1);
    assert.equal(stdout, "Reinstalling MiniCPA 1.1.0 with npm…\nMiniCPA reinstalled: 1.1.0");
  });

  it("never downgrades a locally ahead version, even with --force", async () => {
    let lockCalled = false;
    let npmCalled = false;
    const deps = upgradeDeps({
      fetchLatestMinicpaVersion: async () => "1.1.0",
      installMinicpaVersion: async () => {
        npmCalled = true;
      },
      updateMinicpaVersion: async () => {
        npmCalled = true;
      },
      withMiniCpaLock: async <T>(_command: string, fn: () => Promise<T>) => {
        lockCalled = true;
        return await fn();
      },
    });

    const { stdout } = await captureOutput(() =>
      runUpgrade({ currentVersion: "2.0.0", packageRoot: "/package", force: true }, deps),
    );

    assert.equal(lockCalled, false);
    assert.equal(npmCalled, false);
    assert.equal(
      stdout,
      "MiniCPA is newer than the latest published version (2.0.0 > 1.1.0). No changes made.",
    );
  });

  it("rejects npx, linked, local, and source installations without invoking install", async () => {
    const unsupportedCases = [
      {
        reason: "npx" as const,
        message: "npx cache installations cannot be upgraded in place.",
      },
      {
        reason: "linked" as const,
        message: "npm link, symlink, and junction installations are unsupported.",
      },
      {
        reason: "not-global" as const,
        message: "MiniCPA is a local dependency, not a direct global package.",
      },
      {
        reason: "source-install" as const,
        message: "MiniCPA is running from a source checkout.",
      },
    ];

    for (const unsupported of unsupportedCases) {
      let installCalled = false;
      const deps = upgradeDeps({
        fetchLatestMinicpaVersion: async () => "1.1.0",
        detectNpmGlobalInstall: async () => ({ supported: false, ...unsupported }),
        installMinicpaVersion: async () => {
          installCalled = true;
        },
      });

      await assert.rejects(
        captureOutput(() =>
          runUpgrade({ currentVersion: "1.1.0", packageRoot: "/package", force: true }, deps),
        ),
        (error: Error) => {
          assert.match(error.message, /^MiniCPA cannot upgrade this installation automatically\./);
          assert.doesNotMatch(error.message, /self-upgrade|self-update/i);
          assert.ok(error.message.includes(unsupported.message));
          assert.match(error.message, /npm install -g @astralyn\/minicpa@latest/);
          return true;
        },
      );
      assert.equal(installCalled, false, unsupported.reason);
    }
  });

  it("propagates registry and installation errors", async () => {
    let lockCalled = false;
    const registryDeps = upgradeDeps({
      fetchLatestMinicpaVersion: async () => {
        throw new Error("registry unavailable");
      },
      withMiniCpaLock: async <T>(_command: string, fn: () => Promise<T>) => {
        lockCalled = true;
        return await fn();
      },
    });
    await assert.rejects(
      captureOutput(() =>
        runUpgrade({ currentVersion: "1.0.0", packageRoot: "/package" }, registryDeps),
      ),
      /registry unavailable/,
    );
    assert.equal(lockCalled, false);

    const updateDeps = upgradeDeps({
      updateMinicpaVersion: async () => {
        throw new Error(
          "MiniCPA upgrade failed: npm exited with status 17.\nRetry manually with:\nnpm update -g @astralyn/minicpa",
        );
      },
    });
    await assert.rejects(
      captureOutput(() =>
        runUpgrade({ currentVersion: "1.0.0", packageRoot: "/package" }, updateDeps),
      ),
      /MiniCPA upgrade failed[\s\S]*npm update -g @astralyn\/minicpa/,
    );

    const forceDeps = upgradeDeps({
      installMinicpaVersion: async () => {
        throw new Error(
          "MiniCPA upgrade failed: npm exited with status 17.\nRetry manually with:\nnpm install -g @astralyn/minicpa@1.1.0",
        );
      },
    });
    await assert.rejects(
      captureOutput(() =>
        runUpgrade({ currentVersion: "1.1.0", packageRoot: "/package", force: true }, forceDeps),
      ),
      /MiniCPA upgrade failed[\s\S]*npm install -g @astralyn\/minicpa@1\.1\.0/,
    );
  });
});

describe("runUpgradeCheck", () => {
  it("uses exit 0 for current and ahead, and exit 1 for outdated", async () => {
    const cases: Array<[string, number, string]> = [
      ["1.1.0", 0, "MiniCPA is already up to date (1.1.0)"],
      ["1.0.0", 1, "MiniCPA upgrade available: 1.0.0 → 1.1.0\nRun: cpa upgrade"],
      [
        "2.0.0",
        0,
        "MiniCPA is newer than the latest published version (2.0.0 > 1.1.0). No changes made.",
      ],
    ];

    for (const [currentVersion, expectedExit, expectedOutput] of cases) {
      const deps: UpgradeCheckDeps = {
        fetchLatestMinicpaVersion: async () => "1.1.0",
        compareMinicpaVersions,
      };
      const { stdout } = await captureOutput(() => runUpgradeCheck(currentVersion, deps));
      assert.equal(process.exitCode, expectedExit);
      assert.equal(stdout, expectedOutput);
    }
  });

  it("lets withCliErrors turn registry failures into exit 1", async () => {
    const deps: UpgradeCheckDeps = {
      fetchLatestMinicpaVersion: async () => {
        throw new Error("registry unavailable");
      },
      compareMinicpaVersions,
    };

    const { stderr } = await captureOutput(() =>
      withCliErrors(async () => {
        await runUpgradeCheck("1.0.0", deps);
      })(),
    );

    assert.equal(process.exitCode, 1);
    assert.match(stderr, /registry unavailable/);
  });
});
