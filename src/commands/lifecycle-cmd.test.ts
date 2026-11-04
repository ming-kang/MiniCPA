import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readLastMiniCpaEvent, recordMiniCpaEvent } from "../minicpa-log.js";
import {
  activeExecutablePath,
  backupExecutablePath,
  cpaLayout,
  ensureDir,
  resolveCpaHome,
} from "../paths.js";
import type { AutostartState } from "../process/autostart.js";
import type { RunningInfo } from "../process/lifecycle.js";
import { withMiniCpaLock } from "../process/lock.js";
import { writeInstallState, writePidRecord } from "../state.js";
import { withHttpFixture, withHttpsFixture } from "../test-fixtures/http-server.js";
import { captureConsole } from "../test-fixtures/test-env.js";
import {
  formatLocalTime,
  formatUptime,
  runOpen,
  runRestart,
  runStart,
  runStatus,
  runTui,
} from "./lifecycle-cmd.js";

const originalLocalAppData = process.env.LOCALAPPDATA;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalHome = process.env.HOME;
const originalCpaHome = process.env.CPA_HOME;
const originalApiUrl = process.env.MINICPA_API_URL;
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
  process.env.MINICPA_API_URL = "http://127.0.0.1:1";
  return base;
}

/** Prepare an opaque native config and an explicit MiniCPA connection target. */
function writeHomeForBase(baseUrl: string): string {
  const home = resolveCpaHome();
  ensureDir(home);
  process.env.MINICPA_API_URL = baseUrl;
  fs.writeFileSync(cpaLayout(home).configFile, "opaque native configuration\n");
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
  if (originalApiUrl === undefined) delete process.env.MINICPA_API_URL;
  else process.env.MINICPA_API_URL = originalApiUrl;
  process.exitCode = originalExitCode;
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

    const output = await captureConsole(() => runStart({ noWait: true }));
    assert.deepEqual(output.stdout, [
      `CLIProxyAPI is already running (PID ${process.pid})`,
      `API          ${closedBase}`,
      `Web          ${closedBase}/management.html`,
    ]);

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

  it("does not record a lock conflict as a failed start", async () => {
    useTempRoot();
    const home = resolveCpaHome();
    ensureDir(home);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holding = withMiniCpaLock("update", async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await ready;
    try {
      await assert.rejects(() => runStart({ noWait: true }), /Another cpa update|lock lease/i);
    } finally {
      release();
      await holding;
    }
    assert.equal(readLastMiniCpaEvent(home), undefined);
  });
});

describe("runRestart", () => {
  it("records its own start attempt instead of leaving an older event in place", async () => {
    useTempRoot();
    let closedBase = "";
    await withHttpFixture({}, async (baseUrl) => {
      closedBase = baseUrl;
    });
    const home = writeHomeForBase(closedBase);
    recordMiniCpaEvent(home, "error", "start failed: port in use");
    // No PID record: stop is a no-op; with no binary the start itself fails and records it.
    await assert.rejects(() => runRestart({ noWait: true }), /binary not found/);
    assert.match(readLastMiniCpaEvent(home)?.message ?? "", /^start failed: CLIProxyAPI binary/);
  });
});

describe("configuration ownership", () => {
  it("does not read configuration for startup, warnings or endpoint reporting", async () => {
    useTempRoot();
    await withHttpFixture(
      {
        "/": (_req, res) => {
          res.end("ok");
        },
      },
      async (baseUrl) => {
        const home = writeHomeForBase(baseUrl);
        const file = cpaLayout(home).configFile;
        writePidRecord(home, {
          pid: process.pid,
          exe: process.execPath,
          startedAt: new Date().toISOString(),
        });
        const originalOpen = fs.openSync;
        let reads = 0;
        fs.openSync = (target, ...args) => {
          if (String(target) === file) reads++;
          return originalOpen(target, ...args);
        };
        try {
          await captureConsole(() => runStart({ noWait: true }));
          assert.equal(reads, 0);
          reads = 0;
          await captureConsole(() =>
            runStatus("0.4.3", { inspectAutostartState: async () => "off" }),
          );
          assert.equal(reads, 0);
        } finally {
          fs.openSync = originalOpen;
        }
      },
    );
  });
});

describe("runOpen", () => {
  it("opens immediately without probing even when the service and panel return errors", async () => {
    useTempRoot();
    let requests = 0;
    await withHttpFixture(
      {
        "/": (_req, res) => {
          requests++;
          res.statusCode = 503;
          res.end();
        },
        "/management.html": (_req, res) => {
          requests++;
          res.statusCode = 404;
          res.end();
        },
      },
      async (baseUrl) => {
        process.env.MINICPA_API_URL = baseUrl;
        const launched: string[] = [];
        const output = await captureConsole(() =>
          runOpen({
            openInBrowser: async (url) => {
              launched.push(url);
            },
          }),
        );
        assert.deepEqual(launched, [`${baseUrl}/management.html`]);
        assert.deepEqual(output.stdout, launched);
        assert.equal(requests, 0, "web must leave HTTP access to the browser");
        assert.equal(fs.existsSync(resolveCpaHome()), false, "web needs no installation or config");
      },
    );
  });

  it("opens the default URL even when CPA has not been initialized or started", async () => {
    useTempRoot();
    delete process.env.MINICPA_API_URL;
    const launched: string[] = [];
    await captureConsole(() =>
      runOpen({
        openInBrowser: async (url) => {
          launched.push(url);
        },
      }),
    );
    assert.deepEqual(launched, ["http://127.0.0.1:8317/management.html"]);
    assert.equal(fs.existsSync(resolveCpaHome()), false);
  });

  it("does not read existing configuration", async () => {
    useTempRoot();
    const home = writeHomeForBase("http://127.0.0.1:19090");
    const originalRead = fs.readFileSync;
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      assert.notEqual(String(file), cpaLayout(home).configFile);
      return (originalRead as (...args: unknown[]) => unknown)(file, ...args);
    }) as typeof fs.readFileSync;
    try {
      await captureConsole(() =>
        runOpen({
          openInBrowser: async (url) => {
            assert.equal(url, "http://127.0.0.1:19090/management.html");
          },
        }),
      );
    } finally {
      fs.readFileSync = originalRead;
    }
  });

  it("keeps a successful exit when no browser launcher exists", async () => {
    useTempRoot();
    const output = await captureConsole(() =>
      runOpen({
        openInBrowser: async () => {
          throw Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" });
        },
      }),
    );
    assert.deepEqual(output.stdout, ["http://127.0.0.1:1/management.html"]);
    assert.deepEqual(output.stderr, [
      "Note: CLIProxyAPI is not running — run: cpa start",
      "Warning: could not open a browser (xdg-open not found)",
      "Open the URL above manually.",
    ]);
    assert.ok(!process.exitCode, `exit code must stay successful, got ${process.exitCode}`);
  });

  it("omits the not-running note while the recorded process is alive", async () => {
    useTempRoot();
    const home = writeHomeForBase("http://127.0.0.1:1");
    writePidRecord(home, {
      pid: process.pid,
      exe: process.execPath,
      startedAt: new Date().toISOString(),
    });
    const output = await captureConsole(() => runOpen({ openInBrowser: async () => {} }));
    assert.deepEqual(output.stderr, []);
  });

  it("prints the URL before launching and propagates other browser errors", async () => {
    useTempRoot();
    const failure = Object.assign(new Error("browser access denied"), { code: "EACCES" });
    const events: string[] = [];
    const originalLog = console.log;
    console.log = (url: string): void => {
      events.push(url);
    };
    try {
      await assert.rejects(
        () =>
          runOpen({
            openInBrowser: async () => {
              events.push("launch");
              throw failure;
            },
          }),
        (error) => error === failure,
      );
    } finally {
      console.log = originalLog;
    }
    assert.deepEqual(events, ["http://127.0.0.1:1/management.html", "launch"]);
  });

  it("honors an explicit HTTPS, IPv6 and reverse-proxy URL without connecting", async () => {
    useTempRoot();
    process.env.MINICPA_API_URL = "https://[::1]:9443/proxy/prefix/";
    const launched: string[] = [];
    await captureConsole(() =>
      runOpen({
        openInBrowser: async (url) => {
          launched.push(url);
        },
      }),
    );
    assert.deepEqual(launched, ["https://[::1]:9443/proxy/prefix/management.html"]);
  });

  it("rejects an invalid target before printing or opening it", async () => {
    useTempRoot();
    process.env.MINICPA_API_URL = "http://user:secret@localhost:8317";
    const output = await captureConsole(async () => {
      await assert.rejects(
        () =>
          runOpen({
            openInBrowser: async () => assert.fail("invalid URL must not be launched"),
          }),
        /without credentials/,
      );
    });
    assert.deepEqual(output.stdout, []);
    assert.deepEqual(output.stderr, []);
  });
});

describe("formatUptime", () => {
  const now = Date.parse("2026-01-10T12:00:00Z");
  it("rounds down to the two most significant units", () => {
    assert.equal(formatUptime("2026-01-10T11:59:30Z", now), "up <1m");
    assert.equal(formatUptime("2026-01-10T11:55:00Z", now), "up 5m");
    assert.equal(formatUptime("2026-01-10T09:30:00Z", now), "up 2h 30m");
    assert.equal(formatUptime("2026-01-07T07:00:00Z", now), "up 3d 5h");
  });

  it("omits uptime it cannot trust", () => {
    assert.equal(formatUptime(undefined, now), undefined);
    assert.equal(formatUptime("not a date", now), undefined);
    assert.equal(formatUptime("2026-01-11T00:00:00Z", now), undefined);
  });
});

describe("formatLocalTime", () => {
  it("renders stored UTC timestamps in local time to the minute", () => {
    assert.equal(formatLocalTime(new Date(2026, 8, 3, 7, 4, 59).toISOString()), "2026-09-03 07:04");
    assert.equal(formatLocalTime("garbage"), "garbage");
  });
});

/** Run `cpa status` with a fixed autostart state and return its output. */
async function status(
  autostart: () => Promise<AutostartState> = async () => "off",
): Promise<{ stdout: string[]; stderr: string[] }> {
  return captureConsole(() => runStatus("0.4.3", { inspectAutostartState: autostart }));
}

describe("runStatus", () => {
  it("prints one aligned block with the next step even while stopped", async () => {
    useTempRoot();
    const home = writeHomeForBase("http://127.0.0.1:19090");
    const output = await status();
    assert.deepEqual(output.stdout.slice(0, 7), [
      "Status       stopped (run: cpa start)",
      "API          http://127.0.0.1:19090",
      "Web          http://127.0.0.1:19090/management.html",
      "Autostart    off",
      "CLIProxyAPI  not installed",
      "MiniCPA      0.4.3",
      `Home         ${home}`,
    ]);
    assert.ok(output.stdout.includes("! CLIProxyAPI binary missing — run: cpa update"));
    assert.equal(process.exitCode, 1);
  });

  it("points a fresh machine at cpa init without listing problems", async () => {
    useTempRoot();
    const output = await status();
    assert.equal(output.stdout[0], "Status       not initialized (run: cpa init)");
    assert.ok(!output.stdout.some((line) => line.startsWith("!")), output.stdout.join("\n"));
  });

  it("surfaces the last failed start that an autostart launch left behind", async () => {
    useTempRoot();
    const home = writeHomeForBase("http://127.0.0.1:19090");
    fs.writeFileSync(activeExecutablePath(home), "binary");
    writeInstallState(home, { runtimeVersion: "7.2.92" });
    recordMiniCpaEvent(home, "error", "start failed: port in use", new Date(2026, 0, 10, 8, 5));
    const output = await status();
    assert.deepEqual(output.stdout.slice(-2), [
      "",
      "! last start failed (2026-01-10 08:05): port in use",
    ]);
  });

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

    const output = await status();

    assert.ok(
      output.stdout.some((line) => line.startsWith("! only the backup binary is left")),
      output.stdout.join("\n"),
    );
    assert.deepEqual(snapshotHome(home), before, "cpa status must not mutate the instance home");
    assert.equal(fs.existsSync(activeExecutablePath(home)), false);
  });

  it("continues reporting runtime status when autostart inspection fails", async () => {
    useTempRoot();

    const output = await status(async () => {
      throw new Error("user manager unavailable");
    });

    assert.ok(output.stdout.includes("Autostart    unknown"), output.stdout.join("\n"));
    assert.ok(output.stdout.includes("CLIProxyAPI  not installed"), output.stdout.join("\n"));
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

    const output = await status();

    assert.ok(output.stdout.includes("CLIProxyAPI  7.2.92"), output.stdout.join("\n"));
  });

  it("explains stale and OS-disabled registrations instead of collapsing them into off", async () => {
    useTempRoot();

    const stale = await status(async () => "stale");
    assert.ok(
      stale.stdout.includes(
        "Autostart    stale (registered for a different MiniCPA launcher — run: cpa auto on)",
      ),
      stale.stdout.join("\n"),
    );
    const disabled = await status(async () => "disabled");
    assert.ok(
      disabled.stdout.includes("Autostart    disabled by the OS (run: cpa auto on)"),
      disabled.stdout.join("\n"),
    );
  });

  it("reports explicit HTTPS URLs and readiness without inspecting TLS settings", async () => {
    useTempRoot();
    await withHttpsFixture(
      {
        "/management.html": (_req, res) => {
          res.statusCode = 200;
          res.end("ok");
        },
      },
      async (baseUrl) => {
        const home = writeHomeForBase(baseUrl);
        writePidRecord(home, {
          pid: process.pid,
          exe: process.execPath,
          startedAt: new Date().toISOString(),
        });

        const output = await status(async () => "on");

        assert.match(
          output.stdout[0] ?? "",
          new RegExp(`^Status +running \\(PID ${process.pid}, up`),
        );
        assert.ok(
          output.stdout.includes(`API          ${baseUrl} (reachable)`),
          output.stdout.join("\n"),
        );
        assert.ok(
          output.stdout.includes(`Web          ${baseUrl}/management.html`),
          output.stdout.join("\n"),
        );
        assert.ok(output.stdout.includes("Autostart    on"), output.stdout.join("\n"));
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
        inspectRunning: async () => fakeRunning(backupExecutablePath(home)),
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
          inspectRunning: async () => fakeRunning(activeExecutablePath(home)),
          runRuntimeAttached: async () => {
            launched = true;
          },
        }),
      /cpa update/,
    );
    assert.equal(launched, false);
  });
});
