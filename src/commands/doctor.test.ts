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
import { withHttpsFixture } from "../test-fixtures/http-server.js";
import type { GithubReachability } from "../update/github-client.js";
import { DEFAULT_LOG_ROTATE_BYTES } from "../util.js";
import type { AutostartState } from "../process/autostart.js";
import { runDoctor, type DoctorDeps } from "./doctor.js";

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

/**
 * Run doctor with stubbed probes (never touches the network, the registry, or
 * systemctl) and collect stdout. Pass overrides to exercise specific checks.
 */
async function runDoctorCapturing(deps: Partial<DoctorDeps> = {}): Promise<string[]> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await runDoctor({
      checkGithubReachability: async () => ANONYMOUS_REACHABILITY,
      inspectAutostartState: async () => "off",
      inspectLingerEnabled: async () => undefined,
      ...deps,
    });
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
      assert.ok(hasLine(lines, "[fail] instance directory not writable"), lines.join("\n"));
      assert.equal(process.exitCode, 1);
      assert.equal(fs.existsSync(path.join(home, ".minicpa-write-probe")), false);
    } else {
      // POSIX keeps access(W_OK), which is accurate there, so the probe never runs.
      assert.ok(hasLine(lines, "[ ok ] instance directory writable"), lines.join("\n"));
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

    assert.ok(hasLine(lines, "[ ok ] CLIProxyAPI binary "), lines.join("\n"));
    assert.ok(
      hasLine(
        lines,
        "[warn] CLIProxyAPI binary is present but not runnable (version probe failed)",
      ),
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

    assert.ok(hasLine(lines, "[warn] active CLIProxyAPI binary missing"), lines.join("\n"));
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

    const lines = await runDoctorCapturing({
      checkGithubReachability: async () => ({ ok: true, remaining: 4990, authenticated: true }),
    });

    assert.ok(
      hasLine(lines, "[ ok ] GitHub API (rate remaining=4990, authenticated)"),
      lines.join("\n"),
    );
    assert.equal(hasLine(lines, "anonymous"), false);
  });

  it("probes and reports HTTPS readiness when CPA is running with TLS enabled", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    await withHttpsFixture(
      {
        "/management.html": (_req, res) => {
          res.statusCode = 200;
          res.end("ok");
        },
      },
      async (baseUrl) => {
        const port = new URL(baseUrl).port;
        fs.writeFileSync(
          cpaLayout(home).configFile,
          `host: "127.0.0.1"\nport: ${port}\ntls:\n  enable: true\n`,
        );
        writePidRecord(home, {
          pid: process.pid,
          exe: process.execPath,
          startedAt: new Date().toISOString(),
        });

        const lines = await runDoctorCapturing();

        assert.ok(
          hasLine(lines, `[ ok ] HTTP https://127.0.0.1:${port}/management.html`),
          lines.join("\n"),
        );
      },
    );
  });

  it("reports every autostart state before the network probes", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    fs.writeFileSync(cpaLayout(home).configFile, "port: 8317\n");

    const cases: Array<[AutostartState, string]> = [
      ["on", "[ ok ] autostart on"],
      ["off", "[info] autostart off (cpa auto on)"],
      ["stale", "[warn] autostart registration targets a different launcher"],
      ["disabled", "[warn] autostart registration disabled by the OS"],
    ];
    for (const [state, expected] of cases) {
      const lines = await runDoctorCapturing({
        inspectAutostartState: async () => state,
      });
      assert.ok(hasLine(lines, expected), lines.join("\n"));
      assert.ok(
        lines.findIndex((line) => line.includes("autostart")) <
          lines.findIndex((line) => line.includes("proxy env")),
        "autostart must be reported before proxy/network probes",
      );
    }
  });

  it("reports autostart inspection failures without failing the report", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    fs.writeFileSync(cpaLayout(home).configFile, "port: 8317\n");

    const lines = await runDoctorCapturing({
      inspectAutostartState: async () => {
        throw new Error("registry denied");
      },
    });

    assert.ok(hasLine(lines, "[warn] cannot inspect autostart: registry denied"), lines.join("\n"));
    // The report continues past the failure: the network probe still runs.
    assert.ok(hasLine(lines, "GitHub API"), lines.join("\n"));
  });

  it("warns about systemd linger only on Linux with an enabled registration", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    fs.writeFileSync(cpaLayout(home).configFile, "port: 8317\n");

    const on = await runDoctorCapturing({
      platform: "linux",
      inspectAutostartState: async () => "on",
      inspectLingerEnabled: async () => undefined,
    });
    assert.ok(hasLine(on, "[info] systemd linger off"), on.join("\n"));

    const lingerOn = await runDoctorCapturing({
      platform: "linux",
      inspectAutostartState: async () => "on",
      inspectLingerEnabled: async () => true,
    });
    assert.equal(hasLine(lingerOn, "systemd linger off"), false, lingerOn.join("\n"));

    const notLinux = await runDoctorCapturing({
      platform: "win32",
      inspectAutostartState: async () => "on",
      inspectLingerEnabled: async () => undefined,
    });
    assert.equal(hasLine(notLinux, "systemd linger off"), false, notLinux.join("\n"));
  });
});
