import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readLastMiniCpaEvent } from "../minicpa-log.js";
import {
  activeExecutablePath,
  backupExecutablePath,
  cpaLayout,
  ensureDir,
  resolveCpaHome,
  unlockProbePath,
} from "../paths.js";
import type { RunningInfo } from "../process/lifecycle.js";
import { writeInstallState, writePidRecord } from "../state.js";
import { withHttpFixture, withHttpsFixture } from "../test-fixtures/http-server.js";
import { captureConsole } from "../test-fixtures/test-env.js";
import {
  parseLogLineCount,
  runLogs,
  runOpen,
  runStart,
  runStatus,
  runTui,
} from "./lifecycle-cmd.js";

const originalLocalAppData = process.env.LOCALAPPDATA;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalHome = process.env.HOME;
const originalCpaHome = process.env.CPA_HOME;
const originalExitCode = process.exitCode;
const temps: string[] = [];

/** Point every app-root lookup at a throwaway directory. */
function useTempRoot(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-lifecycle-cmd-"));
  temps.push(base);
  process.env.LOCALAPPDATA = base;
  process.env.XDG_DATA_HOME = base;
  process.env.HOME = base;
  delete process.env.CPA_HOME;
  return base;
}

/** Create the instance home with a config.yaml pointing at `baseUrl`'s port. */
function writeHomeForBase(baseUrl: string, tls = false): string {
  const home = resolveCpaHome();
  ensureDir(home);
  const port = new URL(baseUrl).port;
  const tlsYaml = tls ? "\ntls:\n  enable: true\n" : "";
  fs.writeFileSync(cpaLayout(home).configFile, `host: "127.0.0.1"\nport: ${port}${tlsYaml}\n`);
  return home;
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

describe("parseLogLineCount", () => {
  it("accepts positive whole numbers", () => {
    assert.equal(parseLogLineCount("80"), 80);
  });

  it("rejects invalid values", () => {
    for (const value of ["0", "-1", "12.5", "12logs", "", "999999999999999999999"]) {
      assert.throws(() => parseLogLineCount(value), /positive whole number/);
    }
  });
});

describe("runStart", () => {
  it("records the failure an autostart launch would otherwise swallow", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    // No config.yaml: startDaemon throws before the CPA child exists, so at login
    // this reason reaches neither the discarded terminal output nor cpa.err.log.
    await assert.rejects(() => runStart({ noWait: true }), /Missing config/);

    const recorded = readLastMiniCpaEvent(home);
    assert.equal(recorded?.level, "error");
    assert.match(recorded?.message ?? "", /^start failed: Missing config/);
  });

  it("records a successful start so an empty log means the launcher never fired", async () => {
    useTempRoot();
    let closedBase = "";
    await withHttpFixture({}, async (baseUrl) => {
      closedBase = baseUrl;
    });
    const home = writeHomeForBase(closedBase);
    // A record for this live process makes startDaemon adopt it as the running
    // instance, so --no-wait returns without spawning anything.
    writePidRecord(home, {
      pid: process.pid,
      exe: process.execPath,
      startedAt: new Date().toISOString(),
    });

    await captureConsole(() => runStart({ noWait: true }));

    const recorded = readLastMiniCpaEvent(home);
    assert.equal(recorded?.level, "info");
    assert.equal(recorded?.message, `start ok pid=${process.pid}`);
  });

  it("keeps the original failure when the log itself cannot be written", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    // A directory where the log belongs makes every append fail; the command must
    // still report the reason it was actually failing for.
    fs.mkdirSync(cpaLayout(home).minicpaLogFile, { recursive: true });

    await assert.rejects(() => runStart({ noWait: true }), /Missing config/);
  });
});

describe("runOpen", () => {
  it("blames the missing panel, not a stopped CPA, on a binary-only install", async () => {
    useTempRoot();
    await withHttpFixture(
      {
        "/": (_req, res) => {
          res.statusCode = 200;
          res.end("ok");
        },
      },
      async (baseUrl) => {
        writeHomeForBase(baseUrl);
        await assert.rejects(
          () => runOpen(),
          (err: Error) => {
            assert.match(err.message, /cpa update --panel/);
            assert.equal(/cpa start/.test(err.message), false, err.message);
            return true;
          },
        );
      },
    );
  });

  it("tells the user to start CPA when nothing answers", async () => {
    useTempRoot();
    let closedBase = "";
    await withHttpFixture({}, async (baseUrl) => {
      closedBase = baseUrl;
    });
    writeHomeForBase(closedBase);

    await assert.rejects(() => runOpen(), /cpa start/);
  });

  it("keeps a successful exit when no browser launcher exists", async () => {
    useTempRoot();
    await withHttpFixture(
      {
        "/management.html": (_req, res) => {
          res.statusCode = 200;
          res.end("panel");
        },
      },
      async (baseUrl) => {
        writeHomeForBase(baseUrl);
        const out: string[] = [];
        const errs: string[] = [];
        const originalLog = console.log;
        const originalError = console.error;
        console.log = (...args: unknown[]): void => {
          out.push(args.map((arg) => String(arg)).join(" "));
        };
        console.error = (...args: unknown[]): void => {
          errs.push(args.map((arg) => String(arg)).join(" "));
        };
        try {
          await runOpen({
            openInBrowser: async () => {
              const err: NodeJS.ErrnoException = new Error("spawn xdg-open ENOENT");
              err.code = "ENOENT";
              throw err;
            },
          });
        } finally {
          console.log = originalLog;
          console.error = originalError;
        }

        assert.ok(
          out.some((line) => line.includes(`${baseUrl}/management.html`)),
          out.join("\n"),
        );
        assert.ok(
          errs.some((line) => line.includes("could not open a browser (xdg-open not found)")),
          errs.join("\n"),
        );
        assert.ok(!process.exitCode, `exit code must stay successful, got ${process.exitCode}`);
      },
    );
  });

  it("opens HTTPS panel URL when tls is enabled", async () => {
    useTempRoot();
    await withHttpsFixture(
      {
        "/management.html": (_req, res) => {
          res.statusCode = 200;
          res.end("panel");
        },
      },
      async (baseUrl) => {
        writeHomeForBase(baseUrl, true);
        const launched: string[] = [];
        await runOpen({
          openInBrowser: async (url) => {
            launched.push(url);
          },
        });
        assert.deepEqual(launched, [`${baseUrl}/management.html`]);
        assert.ok(launched[0]?.startsWith("https://"));
      },
    );
  });
});

describe("runStatus", () => {
  it("never repairs the instance home while reporting on it", async () => {
    useTempRoot();
    let closedBase = "";
    await withHttpFixture({}, async (baseUrl) => {
      closedBase = baseUrl;
    });
    const home = writeHomeForBase(closedBase);
    // Crash residue from an interrupted update: only the rollback binary is left.
    fs.writeFileSync(backupExecutablePath(home), "rollback-binary");
    // A record for a live process is what makes the repairing lookup act: it
    // resolves the executable (restoring the `.bak` over the active name) before
    // it can decide whether the PID really is the managed CPA.
    writePidRecord(home, {
      pid: process.pid,
      exe: process.execPath,
      startedAt: new Date().toISOString(),
    });
    const before = snapshotHome(home);

    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]): void => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      await runStatus({ inspectAutostartState: async () => "off" });
    } finally {
      console.log = originalLog;
    }

    assert.ok(
      lines.some((line) => line.includes("Autostart  off")),
      lines.join("\n"),
    );
    assert.deepEqual(snapshotHome(home), before, "cpa status must not mutate the instance home");
    assert.equal(fs.existsSync(activeExecutablePath(home)), false);
  });

  it("continues reporting runtime status when autostart inspection fails", async () => {
    useTempRoot();

    const output = await captureConsole(() =>
      runStatus({
        inspectAutostartState: async () => {
          throw new Error("user manager unavailable");
        },
      }),
    );

    assert.ok(
      output.stdout.some((line) => line.startsWith("Home       ")),
      output.stdout.join("\n"),
    );
    assert.ok(output.stdout.includes("Version    (not installed)"), output.stdout.join("\n"));
    assert.ok(output.stdout.includes("Autostart  unknown"), output.stdout.join("\n"));
    assert.ok(output.stdout.includes("Status     stopped"), output.stdout.join("\n"));
    assert.deepEqual(output.stderr, [
      "Warning: could not inspect autostart: user manager unavailable",
    ]);
    assert.equal(process.exitCode, 1);
  });

  it("reports the recorded version without executing the active binary", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    fs.writeFileSync(activeExecutablePath(home), "not a real binary");
    writeInstallState(home, { runtimeVersion: "7.2.92" });

    const output = await captureConsole(() =>
      runStatus({ inspectAutostartState: async () => "off" }),
    );

    assert.ok(output.stdout.includes("Version    7.2.92"), output.stdout.join("\n"));
  });

  it("does not collapse stale or OS-disabled registrations into off", async () => {
    useTempRoot();

    for (const state of ["stale", "disabled"] as const) {
      const output = await captureConsole(() =>
        runStatus({ inspectAutostartState: async () => state }),
      );
      assert.ok(output.stdout.includes(`Autostart  ${state}`), output.stdout.join("\n"));
    }
  });

  it("reports HTTPS URLs and HTTP ok when running with TLS enabled", async () => {
    useTempRoot();
    await withHttpsFixture(
      {
        "/management.html": (_req, res) => {
          res.statusCode = 200;
          res.end("ok");
        },
      },
      async (baseUrl) => {
        const home = writeHomeForBase(baseUrl, true);
        writePidRecord(home, {
          pid: process.pid,
          exe: process.execPath,
          startedAt: new Date().toISOString(),
        });

        const lines: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]): void => {
          lines.push(args.map((arg) => String(arg)).join(" "));
        };
        try {
          await runStatus({ inspectAutostartState: async () => "on" });
        } finally {
          console.log = originalLog;
        }

        assert.ok(
          lines.some((l) => l.includes("Autostart  on")),
          lines.join("\n"),
        );
        assert.ok(
          lines.some((l) => l.includes(`API        ${baseUrl}`)),
          lines.join("\n"),
        );
        assert.ok(
          lines.some((l) => l.includes(`Web        ${baseUrl}/management.html`)),
          lines.join("\n"),
        );
        assert.ok(
          lines.some((l) => l.includes("HTTP       ok")),
          lines.join("\n"),
        );
        assert.equal(process.exitCode, 0);
      },
    );
  });
});

describe("runTui", () => {
  /** A live-looking process record, so the run reaches the executable lookup. */
  function fakeRunning(exe: string): RunningInfo {
    return { pid: process.pid, exe, startedAt: new Date().toISOString() };
  }

  it("launches from the unlock-probe residue without repairing the home", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    fs.writeFileSync(cpaLayout(home).configFile, `host: "127.0.0.1"\nport: 8317\n`);
    // Crash residue from an interrupted update: the binary is on disk, but only
    // under its unlock-probe name. Repairing that is a write, and `cpa tui`
    // holds no lock — `cpa update` may own this very file right now.
    fs.writeFileSync(unlockProbePath(home), "probe-binary");
    const before = snapshotHome(home);

    const launched: Array<{ exe: string; args: string[]; cwd: string }> = [];
    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
    // The home must be intact even when the launch itself fails, so the purity
    // assertion runs before the failure is re-reported.
    let failure: unknown;
    try {
      await runTui({
        inspectRunning: () => fakeRunning(unlockProbePath(home)),
        runRuntimeAttached: async (exe, args, options) => {
          launched.push({ exe, args, cwd: options.cwd });
        },
      });
    } catch (err) {
      failure = err;
    } finally {
      console.error = originalError;
    }

    assert.deepEqual(snapshotHome(home), before, "cpa tui must not mutate the instance home");
    assert.equal(failure, undefined, `cpa tui must not have failed: ${failure}`);
    assert.equal(fs.existsSync(activeExecutablePath(home)), false);
    assert.equal(launched.length, 1);
    assert.equal(launched[0]?.exe, unlockProbePath(home));
    assert.deepEqual(launched[0]?.args, ["-config", cpaLayout(home).configFile, "-tui"]);
    assert.ok(
      warnings.some((line) => line.includes("cpa start")),
      warnings.join("\n"),
    );
  });

  it("does not repair a .bak-only home either", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    fs.writeFileSync(cpaLayout(home).configFile, `host: "127.0.0.1"\nport: 8317\n`);
    fs.writeFileSync(backupExecutablePath(home), "rollback-binary");
    const before = snapshotHome(home);

    const originalError = console.error;
    console.error = (): void => {};
    let launchedExe = "";
    let failure: unknown;
    try {
      await runTui({
        inspectRunning: () => fakeRunning(backupExecutablePath(home)),
        runRuntimeAttached: async (exe) => {
          launchedExe = exe;
        },
      });
    } catch (err) {
      failure = err;
    } finally {
      console.error = originalError;
    }

    assert.deepEqual(snapshotHome(home), before, "cpa tui must not mutate the instance home");
    assert.equal(failure, undefined, `cpa tui must not have failed: ${failure}`);
    assert.equal(launchedExe, backupExecutablePath(home));
    assert.equal(fs.existsSync(activeExecutablePath(home)), false);
  });

  it("refuses to launch when no binary is on disk at all", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    let launched = false;

    await assert.rejects(
      () =>
        runTui({
          inspectRunning: () => fakeRunning(activeExecutablePath(home)),
          runRuntimeAttached: async () => {
            launched = true;
          },
        }),
      /cpa update/,
    );
    assert.equal(launched, false);
  });
});

describe("runLogs", () => {
  it("throws when no log files exist", async () => {
    useTempRoot();
    await assert.rejects(() => runLogs({}), /No log files yet/);
    await assert.rejects(() => runLogs({ errOnly: true }), /Log not found/);
    await assert.rejects(() => runLogs({ follow: true }), /No log files yet/);
  });

  it("prints log tails when files exist", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    const layout = cpaLayout(home);
    ensureDir(layout.logsDir);
    fs.writeFileSync(layout.logFile, "line 1\nline 2\nline 3\n");
    fs.writeFileSync(layout.errLogFile, "err 1\n");

    const { stdout: stdoutAll } = await captureConsole(() => runLogs({ lines: 2 }));
    assert.ok(stdoutAll.some((l) => l.includes("===") && l.includes("cpa.log")));
    assert.ok(stdoutAll.some((l) => l.includes("line 2")));
    assert.ok(stdoutAll.some((l) => l.includes("===") && l.includes("cpa.err.log")));
    assert.ok(stdoutAll.some((l) => l.includes("err 1")));

    const { stdout: stdoutErr } = await captureConsole(() => runLogs({ errOnly: true, lines: 1 }));
    assert.equal(stdoutErr.length, 1);
    assert.equal(stdoutErr[0], "err 1");
  });
});
