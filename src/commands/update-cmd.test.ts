import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { BinaryUpdateResult } from "../update/binary.js";
import type { PanelUpdateResult } from "../update/panel.js";
import {
  assertUpdateScopeFlags,
  runUpdate,
  runUpdateCheck,
  updateCheckExitCode,
  type UpdateCheckDeps,
  type UpdateDeps,
} from "./update-cmd.js";

describe("assertUpdateScopeFlags", () => {
  it("allows zero or one scope flag", () => {
    assert.doesNotThrow(() => assertUpdateScopeFlags({}));
    assert.doesNotThrow(() => assertUpdateScopeFlags({ binary: true }));
    assert.doesNotThrow(() => assertUpdateScopeFlags({ panel: true }));
    assert.doesNotThrow(() => assertUpdateScopeFlags({ all: true }));
  });

  it("rejects combinations", () => {
    assert.throws(() => assertUpdateScopeFlags({ binary: true, panel: true }), /only one/);
    assert.throws(() => assertUpdateScopeFlags({ all: true, binary: true }), /only one/);
    assert.throws(() => assertUpdateScopeFlags({ all: true, panel: true }), /only one/);
  });

  it("rejects binary-only flags combined with --panel", () => {
    assert.throws(
      () => assertUpdateScopeFlags({ panel: true, version: "7.2.66" }),
      /--version and --insecure apply to CLIProxyAPI only/,
    );
    assert.throws(
      () => assertUpdateScopeFlags({ panel: true, insecure: true }),
      /--version and --insecure apply to CLIProxyAPI only/,
    );
  });

  it("allows binary-only flags outside --panel", () => {
    assert.doesNotThrow(() => assertUpdateScopeFlags({ binary: true, version: "7.2.66" }));
    assert.doesNotThrow(() => assertUpdateScopeFlags({ binary: true, insecure: true }));
    assert.doesNotThrow(() => assertUpdateScopeFlags({ version: "7.2.66", insecure: true }));
    assert.doesNotThrow(() => assertUpdateScopeFlags({ panel: true }));
  });
});

describe("updateCheckExitCode", () => {
  it("exits 0 only when both targets are current and no check failed", () => {
    const cases: Array<[boolean, boolean, boolean, boolean, number]> = [
      // binaryUpToDate, panelUpToDate, binaryError, panelError, expected
      [true, true, false, false, 0],
      [true, true, false, true, 1],
      [true, true, true, false, 1],
      [true, true, true, true, 1],
      [true, false, false, false, 1],
      [true, false, false, true, 1],
      [true, false, true, false, 1],
      [true, false, true, true, 1],
      [false, true, false, false, 1],
      [false, true, false, true, 1],
      [false, true, true, false, 1],
      [false, true, true, true, 1],
      [false, false, false, false, 1],
      [false, false, false, true, 1],
      [false, false, true, false, 1],
      [false, false, true, true, 1],
    ];
    for (const [binaryUpToDate, panelUpToDate, binaryError, panelError, expected] of cases) {
      assert.equal(
        updateCheckExitCode({ binaryUpToDate, panelUpToDate, binaryError, panelError }),
        expected,
        `binary=${binaryUpToDate} panel=${panelUpToDate} binaryError=${binaryError} error=${panelError}`,
      );
    }
  });
});

// ── runUpdate / runUpdateCheck branch behavior (no network, injected deps) ──

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
  console.log = (m?: unknown) => out.push(String(m));
  console.error = (m?: unknown) => err.push(String(m));
  try {
    const result = await fn();
    return { stdout: out.join("\n"), stderr: err.join("\n"), result };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const RATE_LIMIT_ERROR =
  "GitHub API 403 for router-for-me/Cli-Proxy-API-Management-Center (releases/latest). " +
  "REST rate limit may be exhausted — set GITHUB_TOKEN or GH_TOKEN and retry.";

const binaryUpdated: () => Promise<BinaryUpdateResult> = async () => ({
  version: "7.2.92",
  previousVersion: "7.2.91",
  skipped: false,
  restarted: true,
});

const panelCurrent: () => Promise<PanelUpdateResult> = async () => ({
  version: "9.9.9",
  previousVersion: "9.9.9",
  skipped: true,
  reason: "already-current",
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

describe("runUpdate leg reporting", () => {
  it("keeps the binary success visible when the panel leg fails (GitHub rate limit)", async () => {
    isolateMiniCpaRoot();
    const deps: UpdateDeps = {
      updateBinary: binaryUpdated,
      updatePanel: async () => {
        throw new Error(RATE_LIMIT_ERROR);
      },
    };

    // Must resolve, not reject: the binary leg succeeded and printed its outcome.
    const { stdout, stderr } = await captureOutput(() => runUpdate({}, deps));

    assert.match(stdout, /CLIProxyAPI updated: 7\.2\.91 → 7\.2\.92 \(restarted\)/);
    assert.match(stderr, /Warning: Web panel update failed: GitHub API 403/);
    assert.match(
      stderr,
      /CLIProxyAPI completed successfully\. Retry only the Web panel: cpa update --panel/,
    );
    // The remedy line must not claim the binary leg failed too.
    assert.ok(!/restored previous binary/i.test(stderr));
    assert.equal(process.exitCode, 1);
  });

  it("does not swallow the panel outcome on success", async () => {
    isolateMiniCpaRoot();
    const deps: UpdateDeps = { updateBinary: binaryUpdated, updatePanel: panelCurrent };

    const { stdout, stderr } = await captureOutput(() => runUpdate({}, deps));

    assert.match(stdout, /CLIProxyAPI updated: 7\.2\.91 → 7\.2\.92 \(restarted\)/);
    assert.match(stdout, /Web panel is already up to date \(9\.9\.9\)/);
    assert.equal(stderr, "");
    assert.equal(process.exitCode, undefined);
  });

  it("never calls the panel leg with --binary", async () => {
    isolateMiniCpaRoot();
    let panelCalled = false;
    const deps: UpdateDeps = {
      updateBinary: binaryUpdated,
      updatePanel: async () => {
        panelCalled = true;
        return { version: "9.9.9", skipped: true, reason: "already-current" as const };
      },
    };

    const { stdout } = await captureOutput(() => runUpdate({ binaryOnly: true }, deps));

    assert.equal(panelCalled, false);
    assert.match(stdout, /CLIProxyAPI updated: 7\.2\.91 → 7\.2\.92 \(restarted\)/);
    assert.doesNotMatch(stdout, /Web panel|skipped/i);
    assert.equal(process.exitCode, undefined);
  });

  it("explains the config opt-out and recommends an explicit Web panel update", async () => {
    isolateMiniCpaRoot();
    const deps: UpdateDeps = {
      updateBinary: binaryUpdated,
      updatePanel: async () => ({
        version: "1.2.3",
        previousVersion: "1.2.3",
        skipped: true,
        reason: "config-opt-out",
      }),
    };

    const { stdout } = await captureOutput(() => runUpdate({}, deps));

    assert.match(stdout, /automatic panel updates are disabled in config\.yaml/);
    assert.match(stdout, /To update it once: cpa update --panel/);
    assert.doesNotMatch(stdout, /--force/);
  });

  it("distinguishes install, reinstall, and explicit version changes", async () => {
    isolateMiniCpaRoot();
    const panelMustNotRun: UpdateDeps["updatePanel"] = async () => {
      throw new Error("unexpected Web panel call");
    };
    const cases: Array<{
      result: BinaryUpdateResult;
      opts: { binaryOnly: true; version?: string };
      expected: RegExp;
    }> = [
      {
        result: { version: "7.2.92", skipped: false, restarted: false },
        opts: { binaryOnly: true },
        expected: /CLIProxyAPI installed: 7\.2\.92/,
      },
      {
        result: {
          version: "7.2.92",
          previousVersion: "7.2.92",
          skipped: false,
          restarted: false,
        },
        opts: { binaryOnly: true },
        expected: /CLIProxyAPI reinstalled: 7\.2\.92/,
      },
      {
        result: {
          version: "7.2.90",
          previousVersion: "7.2.92",
          skipped: false,
          restarted: false,
        },
        opts: { binaryOnly: true, version: "7.2.90" },
        expected: /CLIProxyAPI version changed: 7\.2\.92 → 7\.2\.90/,
      },
    ];

    for (const { result, opts, expected } of cases) {
      const { stdout } = await captureOutput(() =>
        runUpdate(opts, {
          updateBinary: async () => result,
          updatePanel: panelMustNotRun,
        }),
      );
      assert.match(stdout, expected);
    }
  });

  it("prefixes --panel failures so a raw GitHub error is not the whole story", async () => {
    isolateMiniCpaRoot();
    const deps: UpdateDeps = {
      updateBinary: binaryUpdated,
      updatePanel: async () => {
        throw new Error(RATE_LIMIT_ERROR);
      },
    };

    await assert.rejects(
      captureOutput(() => runUpdate({ panelOnly: true }, deps)),
      /Web panel update failed: GitHub API 403/,
    );
  });
});

describe("runUpdateCheck leg reporting", () => {
  it("reports a failed binary check inline and still prints the panel verdict", async () => {
    isolateMiniCpaRoot();
    const deps: UpdateCheckDeps = {
      checkBinaryUpdate: async () => {
        throw new Error(RATE_LIMIT_ERROR);
      },
      checkPanelUpdate: async () => ({
        current: "9.9.9",
        latest: "9.9.9",
        upToDate: true,
        autoUpdateDisabled: false,
      }),
    };

    const { stdout } = await captureOutput(() => runUpdateCheck(deps));

    assert.match(stdout, /CLIProxyAPI\s+check failed: GitHub API 403/);
    assert.match(stdout, /Web panel\s+current=9\.9\.9\s+latest=9\.9\.9\s+up to date/);
    assert.equal(process.exitCode, 1);
  });

  it("prints the update command when an actionable update is available", async () => {
    isolateMiniCpaRoot();
    const deps: UpdateCheckDeps = {
      checkBinaryUpdate: async () => ({
        current: "7.2.91",
        latest: "7.2.92",
        upToDate: false,
      }),
      checkPanelUpdate: async () => ({
        current: "9.9.9",
        latest: "9.9.9",
        upToDate: true,
        autoUpdateDisabled: false,
      }),
    };

    const { stdout } = await captureOutput(() => runUpdateCheck(deps));

    assert.match(stdout, /CLIProxyAPI\s+current=7\.2\.91\s+latest=7\.2\.92\s+update available/);
    assert.match(stdout, /\nRun: cpa update$/);
    assert.equal(process.exitCode, 1);
  });

  it("reports an opted-out panel as ignored without failing the gate or suggesting update", async () => {
    isolateMiniCpaRoot();
    const deps: UpdateCheckDeps = {
      checkBinaryUpdate: async () => ({
        current: "7.2.92",
        latest: "7.2.92",
        upToDate: true,
      }),
      checkPanelUpdate: async () => ({
        current: "1.2.3",
        latest: "9.9.9",
        upToDate: true,
        autoUpdateDisabled: true,
      }),
    };

    const { stdout } = await captureOutput(() => runUpdateCheck(deps));

    assert.match(
      stdout,
      /Web panel\s+current=1\.2\.3\s+latest=9\.9\.9\s+ignored \(automatic updates disabled in config\.yaml\)/,
    );
    assert.doesNotMatch(stdout, /Web panel.*up to date/);
    assert.doesNotMatch(stdout, /Run: cpa update/);
    assert.equal(process.exitCode, 0);
  });
});
