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
      /--version and --insecure apply to the CPA binary only/,
    );
    assert.throws(
      () => assertUpdateScopeFlags({ panel: true, insecure: true }),
      /--version and --insecure apply to the CPA binary only/,
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
  skipped: false,
  restarted: true,
});

const panelCurrent: () => Promise<PanelUpdateResult> = async () => ({
  version: "9.9.9",
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

    assert.match(stdout, /CPA updated to 7\.2\.92 \(restarted\)/);
    assert.match(stderr, /Warning: panel update failed: GitHub API 403/);
    assert.match(stderr, /Retry the panel with: cpa update --panel/);
    // The remedy line must not claim the binary leg failed too.
    assert.ok(!/restored previous binary/i.test(stderr));
    assert.equal(process.exitCode, 1);
  });

  it("does not swallow the panel outcome on success", async () => {
    isolateMiniCpaRoot();
    const deps: UpdateDeps = { updateBinary: binaryUpdated, updatePanel: panelCurrent };

    const { stdout, stderr } = await captureOutput(() => runUpdate({}, deps));

    assert.match(stdout, /CPA updated to 7\.2\.92 \(restarted\)/);
    assert.match(stdout, /Panel already 9\.9\.9 \(use --force to reinstall\)/);
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
    assert.match(stdout, /Panel skipped \(--binary\)\./);
    assert.equal(process.exitCode, undefined);
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
      /Panel update failed: GitHub API 403/,
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

    assert.match(stdout, /CPA binary\s+error \(GitHub API 403/);
    assert.match(stdout, /Panel\s+current=9\.9\.9\s+latest=9\.9\.9\s+up-to-date/);
    assert.equal(process.exitCode, 1);
  });
});
