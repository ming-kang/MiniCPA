import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { activeExecutablePath, cpaHome, cpaLayout, miniCpaRoot } from "../paths.js";
import type { UpdateDeps } from "./update-cmd.js";
import { runInit } from "./init.js";

const originalLocalAppData = process.env.LOCALAPPDATA;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalHome = process.env.HOME;
const originalCpaHome = process.env.CPA_HOME;
const originalExitCode = process.exitCode;
const temps: string[] = [];

function isolateMiniCpaRoot(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-init-"));
  temps.push(base);
  process.env.LOCALAPPDATA = base;
  process.env.XDG_DATA_HOME = base;
  process.env.HOME = base;
  // A developer shell export must not decide where runInit writes.
  delete process.env.CPA_HOME;
  return cpaHome();
}

async function captureOutput(fn: () => Promise<void>): Promise<{
  stdout: string;
  stderr: string;
  error?: unknown;
}> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown): void => {
    out.push(String(message));
  };
  console.error = (message?: unknown): void => {
    err.push(String(message));
  };
  try {
    await fn();
    return { stdout: out.join("\n"), stderr: err.join("\n") };
  } catch (error) {
    return { stdout: out.join("\n"), stderr: err.join("\n"), error };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
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

describe("runInit", () => {
  it("creates the canonical layout and installs the latest binary and panel in order", async () => {
    const home = isolateMiniCpaRoot();
    const layout = cpaLayout(home);
    const lockPath = path.join(miniCpaRoot(), "state", "cpa.lock");
    const calls: string[] = [];
    const deps: UpdateDeps = {
      updateBinary: async (receivedHome, options) => {
        assert.equal(receivedHome, home);
        assert.ok(fs.existsSync(layout.configFile), "config must exist before component install");
        assert.equal(options?.version, undefined);
        assert.equal(options?.force, undefined);
        assert.equal(options?.insecure, undefined);
        assert.ok(fs.existsSync(lockPath), "binary install must run while init owns the lock");
        calls.push("binary");
        return { version: "7.2.92", skipped: false, restarted: false };
      },
      updatePanel: async (receivedHome, options) => {
        assert.equal(receivedHome, home);
        assert.equal(options?.force, undefined);
        assert.equal(options?.trigger, "explicit");
        assert.ok(fs.existsSync(lockPath), "panel install must run while init owns the lock");
        calls.push("panel");
        return { version: "1.0.0", skipped: false };
      },
    };

    const { stdout, stderr, error } = await captureOutput(() => runInit({}, deps));

    assert.equal(error, undefined);
    assert.equal(stderr, "");
    assert.deepEqual(calls, ["binary", "panel"]);
    assert.equal(home, path.join(miniCpaRoot(), "instance"));
    assert.equal(fs.existsSync(path.join(miniCpaRoot(), "instances")), false);
    assert.equal(fs.existsSync(path.join(miniCpaRoot(), "config.json")), false);

    const configText = fs.readFileSync(layout.configFile, "utf8");
    const apiKey = /-\s+(sk-[a-f0-9]+)/.exec(configText)?.[1];
    assert.ok(apiKey);
    assert.ok(fs.existsSync(layout.envFile));
    assert.match(configText, /api-keys:/);
    assert.ok(!stdout.includes(apiKey));
    assert.match(stdout, /CLIProxyAPI installed: 7\.2\.92/);
    assert.match(stdout, /Web panel installed: 1\.0\.0/);
    assert.match(stdout, /Next:[\s\S]*cpa start[\s\S]*cpa web/);
    assert.doesNotMatch(stdout, /Next:[\s\S]*cpa update/);
    assert.doesNotMatch(stdout, /cpa open/);
    assert.equal(fs.existsSync(lockPath), false);

    if (process.platform !== "win32") {
      for (const target of [
        home,
        layout.authsDir,
        layout.logsDir,
        layout.stateDir,
        layout.staticDir,
        layout.configFile,
        layout.envFile,
      ]) {
        assert.equal(fs.statSync(target).mode & 0o077, 0, target);
      }
    }
  });

  it("keeps --force scoped to config replacement instead of component reinstall", async () => {
    const home = isolateMiniCpaRoot();
    const layout = cpaLayout(home);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(layout.configFile, "port: 9000\n");
    const componentForces: Array<boolean | undefined> = [];
    const deps: UpdateDeps = {
      updateBinary: async (_receivedHome, options) => {
        componentForces.push(options?.force);
        return { version: "7.2.92", skipped: true, restarted: false };
      },
      updatePanel: async (_receivedHome, options) => {
        componentForces.push(options?.force);
        return {
          version: "1.0.0",
          previousVersion: "1.0.0",
          skipped: true,
          reason: "already-current",
        };
      },
    };

    const { error } = await captureOutput(() => runInit({ force: true }, deps));

    assert.equal(error, undefined);
    assert.deepEqual(componentForces, [undefined, undefined]);
    const backups = fs.readdirSync(home).filter((entry) => entry.startsWith("config.yaml.bak."));
    assert.equal(backups.length, 1);
    const [backup] = backups;
    assert.ok(backup);
    assert.equal(fs.readFileSync(path.join(home, backup), "utf8"), "port: 9000\n");
    assert.notEqual(fs.readFileSync(layout.configFile, "utf8"), "port: 9000\n");
  });

  it("preserves initialized files and skips the panel when binary installation fails", async () => {
    const home = isolateMiniCpaRoot();
    const layout = cpaLayout(home);
    let panelCalled = false;
    const deps: UpdateDeps = {
      updateBinary: async () => {
        throw new Error("binary download failed");
      },
      updatePanel: async () => {
        panelCalled = true;
        return { version: "1.0.0", skipped: false };
      },
    };

    const { stdout, error } = await captureOutput(() => runInit({}, deps));

    assert.ok(error instanceof Error);
    assert.match(error.message, /binary download failed/);
    assert.equal(panelCalled, false);
    assert.ok(fs.existsSync(layout.configFile));
    assert.ok(fs.existsSync(layout.envFile));
    assert.doesNotMatch(stdout, /Next:/);
    assert.equal(fs.existsSync(path.join(miniCpaRoot(), "state", "cpa.lock")), false);
  });

  it("keeps a successful binary when the panel fails and exits non-zero", async () => {
    const home = isolateMiniCpaRoot();
    const executable = activeExecutablePath(home);
    const deps: UpdateDeps = {
      updateBinary: async () => {
        fs.writeFileSync(executable, "installed binary");
        return { version: "7.2.92", skipped: false, restarted: false };
      },
      updatePanel: async () => {
        throw new Error("panel digest unavailable");
      },
    };

    const { stdout, stderr, error } = await captureOutput(() => runInit({}, deps));

    assert.equal(error, undefined);
    assert.match(stdout, /CLIProxyAPI installed: 7\.2\.92/);
    assert.doesNotMatch(stdout, /Next:/);
    assert.match(stderr, /Warning: Web panel update failed: panel digest unavailable/);
    assert.match(stderr, /Retry only the Web panel: cpa update --panel/);
    assert.equal(fs.readFileSync(executable, "utf8"), "installed binary");
    assert.equal(process.exitCode, 1);
    assert.equal(fs.existsSync(path.join(miniCpaRoot(), "state", "cpa.lock")), false);
  });
});
