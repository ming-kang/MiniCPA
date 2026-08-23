import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { defaultCpaHome } from "../paths.js";
import { runInit } from "./init.js";

const originalLocalAppData = process.env.LOCALAPPDATA;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalHome = process.env.HOME;
const originalCpaHome = process.env.CPA_HOME;
const temps: string[] = [];

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
});

describe("runInit", () => {
  it("creates a private single-home layout and releases its lock", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-init-"));
    temps.push(base);
    process.env.LOCALAPPDATA = base;
    process.env.XDG_DATA_HOME = base;
    process.env.HOME = base;
    // A developer shell export must not decide where runInit writes.
    delete process.env.CPA_HOME;
    // Resolve after the env assignments: the darwin branch reads os.homedir(), not
    // LOCALAPPDATA/XDG_DATA_HOME, so a hardcoded layout only matches win32 and linux.
    const home = defaultCpaHome();

    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => output.push(String(message));
    try {
      await runInit({});
    } finally {
      console.log = originalLog;
    }

    const config = path.join(home, "config.yaml");
    const env = path.join(home, ".env");
    const configText = fs.readFileSync(config, "utf8");
    const apiKey = /-\s+(sk-[a-f0-9]+)/.exec(configText)?.[1];
    assert.ok(apiKey);
    assert.ok(fs.existsSync(config));
    assert.ok(fs.existsSync(env));
    assert.match(configText, /api-keys:/);
    assert.ok(!output.join("\n").includes(apiKey));
    assert.match(output.join("\n"), /Next:[\s\S]*cpa update[\s\S]*cpa start[\s\S]*cpa web/);
    assert.doesNotMatch(output.join("\n"), /cpa open/);
    assert.equal(fs.existsSync(path.join(home, "state", "cpa.lock")), false);

    if (process.platform !== "win32") {
      for (const target of [
        home,
        path.join(home, "auths"),
        path.join(home, "logs"),
        path.join(home, "state"),
        config,
        env,
      ]) {
        assert.equal(fs.statSync(target).mode & 0o077, 0, target);
      }
    }
  });
});
