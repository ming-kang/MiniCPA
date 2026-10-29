import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { cpaHome, cpaLayout } from "../paths.js";
import { captureConsole, createIsolatedTestEnv } from "../test-fixtures/test-env.js";
import type { BinaryUpdateResult } from "../update/binary.js";
import { runUpdate, runUpdateCheck, updateCheckExitCode } from "./update-cmd.js";

let env: ReturnType<typeof createIsolatedTestEnv> | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function setup(): ReturnType<typeof cpaLayout> {
  env = createIsolatedTestEnv("minicpa-update-cmd-");
  const layout = cpaLayout(cpaHome());
  fs.mkdirSync(layout.home, { recursive: true });
  return layout;
}

const UPDATED: BinaryUpdateResult = {
  version: "8.0.47",
  previousVersion: "8.0.46",
  skipped: false,
  restarted: true,
};

describe("updateCheckExitCode", () => {
  it("exits 0 only when the binary is current and the check succeeded", () => {
    assert.equal(updateCheckExitCode({ binaryUpToDate: true, binaryError: false }), 0);
    assert.equal(updateCheckExitCode({ binaryUpToDate: false, binaryError: false }), 1);
    assert.equal(updateCheckExitCode({ binaryUpToDate: true, binaryError: true }), 1);
    assert.equal(updateCheckExitCode({ binaryUpToDate: false, binaryError: true }), 1);
  });
});

describe("runUpdate", () => {
  it("updates the binary without initializing configuration", async () => {
    const layout = setup();
    const output = await captureConsole(() => runUpdate({}, { updateBinary: async () => UPDATED }));
    assert.match(
      output.stdout.join("\n"),
      /CLIProxyAPI updated: 8\.0\.46 → 8\.0\.47 \(restarted\)/,
    );
    assert.deepEqual(output.stderr, []);
    assert.equal(fs.existsSync(layout.configFile), false);
    assert.equal(fs.existsSync(path.join(layout.home, ".env")), false);
  });

  it("never reads, validates, rewrites or backs up configuration on an update", async () => {
    const layout = setup();
    const opaque = "not even valid YAML: [\n";
    fs.writeFileSync(layout.configFile, opaque);
    const originalRead = fs.readFileSync;
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      assert.notEqual(String(file), layout.configFile, "update must not read configuration");
      return (originalRead as (...args: unknown[]) => unknown)(file, ...args);
    }) as typeof fs.readFileSync;
    try {
      const output = await captureConsole(() =>
        runUpdate(
          { force: true },
          {
            updateBinary: async (home, options) => {
              assert.equal(home, layout.home);
              assert.equal(options?.force, true);
              assert.equal(Object.hasOwn(options ?? {}, "beforeInstall"), false);
              return UPDATED;
            },
          },
        ),
      );
      assert.doesNotMatch(output.stdout.join("\n"), /Config synchronized|Config backup/);
    } finally {
      fs.readFileSync = originalRead;
    }
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), opaque);
    assert.equal(fs.existsSync(path.join(layout.home, "backups")), false);
  });

  it("preserves fixed-slot, legacy and recovery config backups even on download failure", async () => {
    const layout = setup();
    const files = [
      layout.configFile,
      `${layout.configFile}.bak.2026-10-01T12-34-56-789Z`,
      path.join(layout.home, ".config.yaml.replace.bak"),
      path.join(layout.home, "backups", "config", "config.1.yaml"),
    ];
    for (const file of files) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "user data\n");
    }
    await assert.rejects(
      () =>
        captureConsole(() =>
          runUpdate(
            {},
            {
              updateBinary: async () => {
                throw new Error("download failed");
              },
            },
          ),
        ),
      /download failed/,
    );
    for (const file of files) assert.equal(fs.readFileSync(file, "utf8"), "user data\n");
    await captureConsole(() =>
      runUpdate(
        {},
        { updateBinary: async () => ({ ...UPDATED, skipped: true, restarted: false }) },
      ),
    );
    for (const file of files) assert.equal(fs.readFileSync(file, "utf8"), "user data\n");
  });

  it("leaves configuration changes made by CPA during preparation untouched", async () => {
    const layout = setup();
    fs.writeFileSync(layout.configFile, "old native config\n");
    await captureConsole(() =>
      runUpdate(
        {},
        {
          updateBinary: async () => {
            fs.writeFileSync(layout.configFile, "new native config\n");
            return { ...UPDATED, skipped: true, restarted: false };
          },
        },
      ),
    );
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "new native config\n");
    assert.equal(fs.existsSync(path.join(layout.home, "backups")), false);
  });

  it("distinguishes install, reinstall, explicit version changes and already-current binaries", async () => {
    setup();
    const cases: Array<{ result: BinaryUpdateResult; version?: string; expected: RegExp }> = [
      {
        result: { version: "8.0.47", skipped: false, restarted: false },
        expected: /CLIProxyAPI installed: 8\.0\.47/,
      },
      {
        result: { ...UPDATED, previousVersion: "8.0.47", restarted: false },
        expected: /CLIProxyAPI reinstalled: 8\.0\.47/,
      },
      {
        result: { ...UPDATED, version: "8.0.45", restarted: false },
        version: "8.0.45",
        expected: /CLIProxyAPI version changed: 8\.0\.46 → 8\.0\.45/,
      },
      {
        result: { ...UPDATED, skipped: true, restarted: false },
        expected: /CLIProxyAPI is already up to date \(8\.0\.47\)/,
      },
    ];
    for (const { result, version, expected } of cases) {
      const output = await captureConsole(() =>
        runUpdate({ version }, { updateBinary: async () => result }),
      );
      assert.match(output.stdout.join("\n"), expected);
    }
  });
});

describe("runUpdateCheck", () => {
  it("reports only the binary and exits 0 when it is current", async () => {
    setup();
    const output = await captureConsole(() =>
      runUpdateCheck({
        checkBinaryUpdate: async () => ({ current: "8.0.47", latest: "8.0.47", upToDate: true }),
      }),
    );
    assert.match(
      output.stdout.join("\n"),
      /CLIProxyAPI\s+current=8\.0\.47\s+latest=8\.0\.47\s+up to date/,
    );
    assert.doesNotMatch(output.stdout.join("\n"), /Web panel|Config synchronized/i);
    assert.equal(process.exitCode, 0);
  });

  it("prints the update command and exits 1 when a binary update is available", async () => {
    setup();
    const output = await captureConsole(() =>
      runUpdateCheck({
        checkBinaryUpdate: async () => ({ current: "8.0.46", latest: "8.0.47", upToDate: false }),
      }),
    );
    assert.match(output.stdout.join("\n"), /update available/);
    assert.match(output.stdout.join("\n"), /Run: cpa update$/);
    assert.equal(process.exitCode, 1);
  });

  it("reports a failed check inline", async () => {
    setup();
    const output = await captureConsole(() =>
      runUpdateCheck({
        checkBinaryUpdate: async () => {
          throw new Error("GitHub API 403: rate limit exhausted");
        },
      }),
    );
    assert.match(output.stdout.join("\n"), /check failed: GitHub API 403/);
    assert.equal(process.exitCode, 1);
  });
});
