import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { cpaLayout, miniCpaRoot, resolveCpaHome } from "../paths.js";
import type { BinaryUpdateResult } from "../update/binary.js";
import {
  runUpdate,
  runUpdateCheck,
  updateCheckExitCode,
  type UpdateCheckDeps,
  type UpdateDeps,
} from "./update-cmd.js";

describe("updateCheckExitCode", () => {
  it("exits 0 only when the binary is current and the check succeeded", () => {
    assert.equal(updateCheckExitCode({ binaryUpToDate: true, binaryError: false }), 0);
    assert.equal(updateCheckExitCode({ binaryUpToDate: false, binaryError: false }), 1);
    assert.equal(updateCheckExitCode({ binaryUpToDate: true, binaryError: true }), 1);
    assert.equal(updateCheckExitCode({ binaryUpToDate: false, binaryError: true }), 1);
  });
});

const savedEnv = {
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  HOME: process.env.HOME,
  CPA_HOME: process.env.CPA_HOME,
};
const savedExitCode = process.exitCode;
const temps: string[] = [];

function isolateMiniCpaRoot(): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-update-cmd-"));
  temps.push(base);
  process.env.LOCALAPPDATA = base;
  process.env.XDG_DATA_HOME = base;
  process.env.HOME = base;
  delete process.env.CPA_HOME;
}

async function captureOutput<T>(fn: () => Promise<T>): Promise<{
  stdout: string;
  stderr: string;
  result: T;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => out.push(String(message));
  console.error = (message?: unknown) => err.push(String(message));
  try {
    const result = await fn();
    return { stdout: out.join("\n"), stderr: err.join("\n"), result };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const RATE_LIMIT_ERROR =
  "GitHub API 403 for router-for-me/CLIProxyAPI (releases/latest). " +
  "REST rate limit may be exhausted — set GITHUB_TOKEN or GH_TOKEN and retry.";

const binaryUpdated: () => Promise<BinaryUpdateResult> = async () => ({
  version: "7.2.92",
  previousVersion: "7.2.91",
  skipped: false,
  restarted: true,
});

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.exitCode = savedExitCode;
});

describe("runUpdate reporting", () => {
  it("updates the CLIProxyAPI binary when config is not initialized", async () => {
    isolateMiniCpaRoot();
    const deps: UpdateDeps = { updateBinary: binaryUpdated };

    const { stdout, stderr } = await captureOutput(() => runUpdate({}, deps));

    assert.match(stdout, /CLIProxyAPI updated: 7\.2\.91 → 7\.2\.92 \(restarted\)/);
    assert.doesNotMatch(stdout, /Web panel/i);
    assert.equal(stderr, "");
    assert.equal(process.exitCode, undefined);
  });

  it("synchronizes an existing config before updating the binary", async () => {
    isolateMiniCpaRoot();
    const home = resolveCpaHome();
    const layout = cpaLayout(home);
    fs.mkdirSync(home, { recursive: true });
    const existing =
      '# old comments\nhost: "0.0.0.0"\nport: 9000\napi-keys:\n  - "sk-existing"\nlogging-to-file: false\n';
    fs.writeFileSync(layout.configFile, existing);
    let inspectedSynchronizedConfig = false;

    const { stdout } = await captureOutput(() =>
      runUpdate(
        {},
        {
          updateBinary: async () => {
            const configText = fs.readFileSync(layout.configFile, "utf8");
            assert.match(configText, /^# CLIProxyAPI 中文配置示例/);
            assert.match(configText, /pprof:\n {2}enable: false/);
            assert.match(configText, /host: 0\.0\.0\.0/);
            assert.match(configText, /port: 9000/);
            assert.match(configText, /- sk-existing/);
            assert.match(configText, /logging-to-file: true/);
            assert.ok(fs.existsSync(path.join(miniCpaRoot(), "state", "cpa.lock")));
            inspectedSynchronizedConfig = true;
            return { version: "7.2.92", skipped: true, restarted: false };
          },
        },
      ),
    );

    assert.equal(inspectedSynchronizedConfig, true);
    assert.match(
      stdout,
      /Config synchronized: .*config\.yaml \(\d+ defaults added, 1 settings updated\)/,
    );
    assert.match(stdout, /Config backup:/);
    assert.match(stdout, /Config changes apply on the next cpa start\/restart\./);
    const backups = fs.readdirSync(home).filter((entry) => entry.startsWith("config.yaml.bak."));
    assert.equal(backups.length, 1);
    const backup = backups[0];
    assert.ok(backup);
    assert.equal(fs.readFileSync(path.join(home, backup), "utf8"), existing);
  });

  it("distinguishes install, reinstall, and explicit version changes", async () => {
    isolateMiniCpaRoot();
    const cases: Array<{
      result: BinaryUpdateResult;
      opts: { version?: string };
      expected: RegExp;
    }> = [
      {
        result: { version: "7.2.92", skipped: false, restarted: false },
        opts: {},
        expected: /CLIProxyAPI installed: 7\.2\.92/,
      },
      {
        result: {
          version: "7.2.92",
          previousVersion: "7.2.92",
          skipped: false,
          restarted: false,
        },
        opts: {},
        expected: /CLIProxyAPI reinstalled: 7\.2\.92/,
      },
      {
        result: {
          version: "7.2.90",
          previousVersion: "7.2.92",
          skipped: false,
          restarted: false,
        },
        opts: { version: "7.2.90" },
        expected: /CLIProxyAPI version changed: 7\.2\.92 → 7\.2\.90/,
      },
    ];

    for (const { result, opts, expected } of cases) {
      const { stdout } = await captureOutput(() =>
        runUpdate(opts, { updateBinary: async () => result }),
      );
      assert.match(stdout, expected);
    }
  });

  it("reports an already-current binary", async () => {
    isolateMiniCpaRoot();
    const { stdout } = await captureOutput(() =>
      runUpdate(
        {},
        {
          updateBinary: async () => ({ version: "7.2.92", skipped: true, restarted: false }),
        },
      ),
    );

    assert.match(stdout, /CLIProxyAPI is already up to date \(7\.2\.92\)/);
  });
});

describe("runUpdateCheck reporting", () => {
  it("reports the current binary without a panel network check", async () => {
    isolateMiniCpaRoot();
    const deps: UpdateCheckDeps = {
      checkBinaryUpdate: async () => ({
        current: "7.2.92",
        latest: "7.2.92",
        upToDate: true,
      }),
    };

    const { stdout } = await captureOutput(() => runUpdateCheck(deps));

    assert.match(stdout, /CLIProxyAPI\s+current=7\.2\.92\s+latest=7\.2\.92\s+up to date/);
    assert.doesNotMatch(stdout, /Web panel/i);
    assert.equal(process.exitCode, 0);
  });

  it("prints the update command when a binary update is available", async () => {
    isolateMiniCpaRoot();
    const deps: UpdateCheckDeps = {
      checkBinaryUpdate: async () => ({
        current: "7.2.91",
        latest: "7.2.92",
        upToDate: false,
      }),
    };

    const { stdout } = await captureOutput(() => runUpdateCheck(deps));

    assert.match(stdout, /CLIProxyAPI\s+current=7\.2\.91\s+latest=7\.2\.92\s+update available/);
    assert.match(stdout, /\nRun: cpa update$/);
    assert.equal(process.exitCode, 1);
  });

  it("reports a failed binary check inline", async () => {
    isolateMiniCpaRoot();
    const deps: UpdateCheckDeps = {
      checkBinaryUpdate: async () => {
        throw new Error(RATE_LIMIT_ERROR);
      },
    };

    const { stdout } = await captureOutput(() => runUpdateCheck(deps));

    assert.match(stdout, /CLIProxyAPI\s+check failed: GitHub API 403/);
    assert.equal(process.exitCode, 1);
  });
});
