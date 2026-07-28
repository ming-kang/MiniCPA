import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  activeExecutablePath,
  backupExecutablePath,
  cpaLayout,
  ensureDir,
  miniCpaRoot,
  resolveCpaHome,
} from "../paths.js";
import { writeInstallState, writePidRecord } from "../state.js";
import type { GithubReachability } from "../update/github-client.js";
import { DEFAULT_LOG_ROTATE_BYTES } from "../util.js";
import { runDoctor } from "./doctor.js";

const originalLocalAppData = process.env.LOCALAPPDATA;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalHome = process.env.HOME;
const originalCpaHome = process.env.CPA_HOME;
const originalExitCode = process.exitCode;
const temps: string[] = [];

/** Point every app-root lookup at a throwaway directory. */
function useTempRoot(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-doctor-"));
  temps.push(base);
  process.env.LOCALAPPDATA = base;
  process.env.XDG_DATA_HOME = base;
  process.env.HOME = base;
  delete process.env.CPA_HOME;
  return base;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdgDataHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCpaHome === undefined) delete process.env.CPA_HOME;
  else process.env.CPA_HOME = originalCpaHome;
  process.exitCode = originalExitCode;
});

const ANONYMOUS_REACHABILITY: GithubReachability = {
  ok: true,
  remaining: 42,
  authenticated: false,
};

/** Run doctor with a stubbed GitHub probe (never touches the network) and collect stdout. */
async function runDoctorCapturing(
  reachability: GithubReachability = ANONYMOUS_REACHABILITY,
): Promise<string[]> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await runDoctor({ checkGithubReachability: async () => reachability });
  } finally {
    console.log = originalLog;
  }
  return lines;
}

function hasLine(lines: string[], needle: string): boolean {
  return lines.some((line) => line.includes(needle));
}

/** Recursive `relative/path=content` listing used to prove a home was untouched. */
function snapshotHome(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    const names = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of names) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        entries.push(`${relative}/`);
        walk(full, relative);
      } else {
        entries.push(`${relative}=${fs.readFileSync(full, "utf8")}`);
      }
    }
  };
  walk(root, "");
  return entries;
}

describe("runDoctor", () => {
  it("fails when config.yaml is missing", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);

    const lines = await runDoctorCapturing();

    assert.ok(hasLine(lines, "[fail] config.yaml missing"), lines.join("\n"));
    assert.equal(process.exitCode, 1);
  });

  it("completes the report when config.yaml cannot be parsed", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    const layout = cpaLayout(home);
    ensureDir(home);
    fs.writeFileSync(layout.configFile, "host: 1\n  bad: [\n");
    // A live, verifiable process is required to reach the readiness probe: the
    // listen address is only derived inside the "running" branch. This process
    // is alive and its executable path matches the record, so it verifies.
    writePidRecord(home, {
      pid: process.pid,
      exe: process.execPath,
      startedAt: new Date().toISOString(),
    });

    const lines = await runDoctorCapturing();

    assert.ok(hasLine(lines, "config.yaml parse error"), lines.join("\n"));
    assert.ok(hasLine(lines, "[fail] cannot derive listen address"), lines.join("\n"));
    // The report must not abort: the sections after the readiness probe are present.
    assert.ok(hasLine(lines, "[info] proxy env"), lines.join("\n"));
    assert.ok(hasLine(lines, "GitHub API"), lines.join("\n"));
    assert.equal(process.exitCode, 1);
  });

  it("probes the home with a real write on Windows, where access(W_OK) lies", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    fs.writeFileSync(cpaLayout(home).configFile, "port: 8317\n");

    // Stand-in for a directory the ACL denies: FILE_ATTRIBUTE_READONLY is clear,
    // so fs.accessSync(W_OK) reports success while every write fails.
    const originalOpenSync = fs.openSync;
    fs.openSync = ((file: fs.PathLike, ...rest: unknown[]): number => {
      if (String(file).includes("minicpa-write-probe")) {
        const err: NodeJS.ErrnoException = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return (originalOpenSync as (...args: unknown[]) => number)(file, ...rest);
    }) as typeof fs.openSync;
    let lines: string[];
    try {
      lines = await runDoctorCapturing();
    } finally {
      fs.openSync = originalOpenSync;
    }

    if (process.platform === "win32") {
      assert.ok(hasLine(lines, "[fail] CPA home not writable"), lines.join("\n"));
      assert.equal(process.exitCode, 1);
      assert.equal(fs.existsSync(path.join(home, ".minicpa-write-probe")), false);
    } else {
      // POSIX keeps access(W_OK), which is accurate there, so the probe never runs.
      assert.ok(hasLine(lines, "[ ok ] CPA home writable"), lines.join("\n"));
    }
  });

  it("warns when the installed binary cannot be probed for its version", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    fs.writeFileSync(cpaLayout(home).configFile, "port: 8317\n");
    // Present under the active name but not a runnable image (wrong arch / EACCES).
    fs.writeFileSync(activeExecutablePath(home), "not a real binary");

    const lines = await runDoctorCapturing();

    assert.ok(hasLine(lines, "[ ok ] binary "), lines.join("\n"));
    assert.ok(
      hasLine(lines, "[warn] binary present but not runnable (version probe failed)"),
      lines.join("\n"),
    );
  });

  it("warns when install state records a runtime version without a binary", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    fs.writeFileSync(cpaLayout(home).configFile, "port: 8317\n");
    writeInstallState(home, { runtimeVersion: "7.2.66" });

    const lines = await runDoctorCapturing();

    assert.ok(
      hasLine(lines, "install state has runtimeVersion but binary is missing/unprobeable"),
      lines.join("\n"),
    );
  });

  it("warns about a log file that has reached the rotation threshold", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    const layout = cpaLayout(home);
    ensureDir(layout.logsDir);
    fs.writeFileSync(layout.configFile, "port: 8317\n");
    fs.writeFileSync(layout.logFile, "");
    fs.truncateSync(layout.logFile, DEFAULT_LOG_ROTATE_BYTES);

    const lines = await runDoctorCapturing();

    assert.ok(
      hasLine(lines, "cpa.log is 50.0 MB — will rotate on next cpa start"),
      lines.join("\n"),
    );
  });

  it("reports a home that only has the backup binary without repairing it", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    fs.writeFileSync(cpaLayout(home).configFile, "port: 8317\n");
    fs.writeFileSync(backupExecutablePath(home), "rollback-binary");
    const before = snapshotHome(home);

    const lines = await runDoctorCapturing();

    assert.ok(hasLine(lines, "[warn] active binary missing"), lines.join("\n"));
    assert.deepEqual(snapshotHome(home), before, "doctor must not mutate the instance home");
  });

  it("surfaces a held MiniCPA lock", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    fs.writeFileSync(cpaLayout(home).configFile, "port: 8317\n");
    const lockDir = path.join(miniCpaRoot(), "state");
    ensureDir(lockDir);
    fs.writeFileSync(
      path.join(lockDir, "cpa.lock"),
      `${JSON.stringify({
        pid: process.pid,
        command: "update",
        acquiredAt: new Date().toISOString(),
      })}\n`,
    );

    const lines = await runDoctorCapturing();

    assert.ok(hasLine(lines, `MiniCPA lock held by PID=${process.pid}`), lines.join("\n"));
    assert.ok(hasLine(lines, "(cpa update)"), lines.join("\n"));
  });

  it("surfaces lock preempt residue", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    fs.writeFileSync(cpaLayout(home).configFile, "port: 8317\n");
    const lockDir = path.join(miniCpaRoot(), "state");
    ensureDir(lockDir);
    fs.writeFileSync(path.join(lockDir, "cpa.lock.preempt.1.x"), "{}\n");

    const lines = await runDoctorCapturing();

    assert.ok(hasLine(lines, "lock preempt residue"), lines.join("\n"));
  });

  it("reports the authenticated GitHub quota when a token is configured", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    fs.writeFileSync(cpaLayout(home).configFile, "port: 8317\n");

    const lines = await runDoctorCapturing({ ok: true, remaining: 4990, authenticated: true });

    assert.ok(
      hasLine(lines, "[ ok ] GitHub API (rate remaining=4990, authenticated)"),
      lines.join("\n"),
    );
    assert.equal(hasLine(lines, "anonymous"), false);
  });
});
