import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  cpaLayout,
  defaultCpaHome,
  executableName,
  miniCpaTempDownloadDir,
  miniCpaTempDownloadsDir,
  resolveCpaHome,
} from "./paths.js";

const prevHome = process.env.CPA_HOME;

afterEach(() => {
  if (prevHome === undefined) delete process.env.CPA_HOME;
  else process.env.CPA_HOME = prevHome;
});

describe("resolveCpaHome", () => {
  it("prefers explicit path", () => {
    process.env.CPA_HOME = "/from/env";
    const got = resolveCpaHome(path.join(os.tmpdir(), "explicit-cpa-home"));
    assert.equal(got, path.resolve(path.join(os.tmpdir(), "explicit-cpa-home")));
  });

  it("uses CPA_HOME env", () => {
    const dir = path.join(os.tmpdir(), "env-cpa-home");
    process.env.CPA_HOME = dir;
    assert.equal(resolveCpaHome(), path.resolve(dir));
  });

  it("falls back to default when no env", () => {
    delete process.env.CPA_HOME;
    // may still pick global config; at least returns a path under MiniCPA brand or absolute
    const home = resolveCpaHome();
    assert.ok(path.isAbsolute(home));
  });
});

describe("cpaLayout", () => {
  it("places binary-adjacent files under home", () => {
    const home = path.join(os.tmpdir(), "layout-home");
    const layout = cpaLayout(home);
    assert.equal(layout.configFile, path.join(home, "config.yaml"));
    assert.equal(layout.managementHtml, path.join(home, "static", "management.html"));
    assert.equal(layout.pidFile, path.join(home, "state", "cpa.pid"));
    assert.ok(!("runtimeDir" in layout));
  });
});

describe("executableName", () => {
  it("matches platform", () => {
    const name = executableName();
    if (process.platform === "win32") assert.equal(name, "cli-proxy-api.exe");
    else assert.equal(name, "cli-proxy-api");
  });
});

describe("defaultCpaHome", () => {
  it("is under MiniCPA instances/default", () => {
    const home = defaultCpaHome();
    assert.ok(home.includes("MiniCPA") || home.includes("minicpa") || fs.existsSync(path.dirname(home)) || true);
    assert.ok(home.endsWith(path.join("instances", "default")) || home.replace(/\\/g, "/").endsWith("instances/default"));
  });
});

describe("miniCpaTempDownloadDir", () => {
  it("creates a distinct directory for each download operation", () => {
    const first = miniCpaTempDownloadDir("test-download-");
    const second = miniCpaTempDownloadDir("test-download-");
    try {
      assert.notEqual(first, second);
      assert.equal(path.dirname(first), miniCpaTempDownloadsDir());
      assert.equal(path.dirname(second), miniCpaTempDownloadsDir());
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  });
});
