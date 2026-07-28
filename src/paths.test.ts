import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  cliConfigPath,
  cpaLayout,
  defaultCpaHome,
  ensureDir,
  executableName,
  hardenCpaPermissions,
  legacyCpaHome,
  MINICPA_DIR_NAME,
  miniCpaRoot,
  miniCpaTempDownloadDir,
  miniCpaTempDownloadsDir,
  miniCpaTempRoot,
  resolveCpaHome,
  writeCliGlobalConfig,
} from "./paths.js";

const prevCpaHome = process.env.CPA_HOME;
const prevLocalAppData = process.env.LOCALAPPDATA;
const prevXdgDataHome = process.env.XDG_DATA_HOME;
const prevUserHome = process.env.HOME;
const temps: string[] = [];

function setAppDataRoot(base: string): void {
  process.env.LOCALAPPDATA = base;
  process.env.XDG_DATA_HOME = base;
  process.env.HOME = base;
  delete process.env.CPA_HOME;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (prevCpaHome === undefined) delete process.env.CPA_HOME;
  else process.env.CPA_HOME = prevCpaHome;
  if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = prevLocalAppData;
  if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevXdgDataHome;
  if (prevUserHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevUserHome;
});

/** The homedir-based root MiniCPA must use when the env override is unusable. */
function homedirDefaultRoot(): string {
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Local", MINICPA_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", MINICPA_DIR_NAME);
  }
  return path.join(os.homedir(), ".local", "share", MINICPA_DIR_NAME);
}

describe("miniCpaRoot", () => {
  it("ignores a relative LOCALAPPDATA/XDG_DATA_HOME", () => {
    const relative = path.join(".local", "share");
    process.env.LOCALAPPDATA = relative;
    process.env.XDG_DATA_HOME = relative;
    delete process.env.CPA_HOME;

    const root = miniCpaRoot();
    assert.equal(path.isAbsolute(root), true);
    assert.equal(root, homedirDefaultRoot());
  });
});

describe("resolveCpaHome", () => {
  it("uses the one persisted home for upgrade compatibility", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-paths-"));
    temps.push(base);
    setAppDataRoot(base);
    const selected = path.join(base, "existing-cpa");
    writeCliGlobalConfig({ home: selected });
    assert.equal(resolveCpaHome(), path.resolve(selected));
  });

  it("rejects CPA_HOME switching", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-paths-"));
    temps.push(base);
    setAppDataRoot(base);
    process.env.CPA_HOME = path.join(base, "another-instance");
    assert.throws(() => resolveCpaHome(), /one instance only/);
  });

  it("falls back to the canonical single home", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-paths-"));
    temps.push(base);
    setAppDataRoot(base);
    assert.equal(resolveCpaHome(), defaultCpaHome());
  });

  it("falls back to the default home when config.json has a non-string home", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-paths-"));
    temps.push(base);
    setAppDataRoot(base);
    ensureDir(miniCpaRoot());
    fs.writeFileSync(cliConfigPath(), `${JSON.stringify({ home: 123 })}\n`);
    assert.equal(resolveCpaHome(), defaultCpaHome());
  });

  it("ignores a config.json that is not an object", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-paths-"));
    temps.push(base);
    setAppDataRoot(base);
    ensureDir(miniCpaRoot());
    fs.writeFileSync(cliConfigPath(), `${JSON.stringify(["not", "an", "object"])}\n`);
    assert.equal(resolveCpaHome(), defaultCpaHome());
  });

  it("migrates from the legacy home only until the default one exists", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-paths-"));
    temps.push(base);
    setAppDataRoot(base);

    const legacy = legacyCpaHome();
    ensureDir(legacy);
    fs.writeFileSync(path.join(legacy, "config.yaml"), "port: 8317\n");
    assert.equal(resolveCpaHome(), legacy);

    const current = defaultCpaHome();
    ensureDir(current);
    fs.writeFileSync(path.join(current, "config.yaml"), "port: 8317\n");
    assert.equal(resolveCpaHome(), current);
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
  it("is the canonical MiniCPA home", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-paths-"));
    temps.push(base);
    setAppDataRoot(base);
    assert.ok(defaultCpaHome().endsWith(path.join("instances", "default")));
  });
});

describe("hardenCpaPermissions", () => {
  it("tightens private data without removing the runtime execute bit", {
    skip: process.platform === "win32",
  }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-permissions-"));
    temps.push(home);
    const layout = cpaLayout(home);
    for (const dir of [layout.authsDir, layout.logsDir, layout.stateDir, layout.staticDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      fs.chmodSync(dir, 0o755);
    }
    const privateFiles = [
      layout.configFile,
      layout.envFile,
      path.join(layout.authsDir, "credential.json"),
      path.join(layout.logsDir, "cpa.log"),
      path.join(layout.stateDir, "install.json"),
      layout.managementHtml,
      `${layout.configFile}.bak.test`,
    ];
    for (const file of privateFiles) {
      fs.writeFileSync(file, "private", { mode: 0o644 });
      fs.chmodSync(file, 0o644);
    }
    const executable = path.join(home, executableName());
    fs.writeFileSync(executable, "bin", { mode: 0o755 });
    fs.chmodSync(executable, 0o755);

    hardenCpaPermissions(home);

    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    for (const dir of [layout.authsDir, layout.logsDir, layout.stateDir, layout.staticDir]) {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    }
    for (const file of privateFiles) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.equal(fs.statSync(executable).mode & 0o777, 0o755);
  });
});

describe("miniCpaTempDownloadDir", () => {
  it("creates distinct staging directories below private app data", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-paths-"));
    temps.push(base);
    setAppDataRoot(base);

    const first = miniCpaTempDownloadDir("test-download-");
    const second = miniCpaTempDownloadDir("test-download-");
    assert.notEqual(first, second);
    assert.equal(path.dirname(first), miniCpaTempDownloadsDir());
    assert.equal(path.dirname(second), miniCpaTempDownloadsDir());
    assert.ok(first.startsWith(miniCpaTempRoot()));
    assert.ok(second.startsWith(miniCpaTempRoot()));
  });
});
