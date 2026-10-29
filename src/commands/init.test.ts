import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { cpaHome, cpaLayout, miniCpaRoot } from "../paths.js";
import { captureConsole, createIsolatedTestEnv } from "../test-fixtures/test-env.js";
import type { UpdateDeps } from "./update-cmd.js";
import { runInit } from "./init.js";

const EXPECTED_CONFIG = `host: "127.0.0.1"
port: 8317

auth-dir: "auths"
api-keys:
  - sk-cliproxyapi

remote-management:
  allow-remote: false
  secret-key: CLIPROXYAPI
  disable-control-panel: false
  disable-auto-update-panel: false
  panel-github-repository: "https://github.com/seakee/CPA-Manager-Plus"
`;

let env: ReturnType<typeof createIsolatedTestEnv> | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function setup(): ReturnType<typeof cpaLayout> {
  env = createIsolatedTestEnv("minicpa-init-");
  return cpaLayout(cpaHome());
}

const currentBinary: UpdateDeps = {
  updateBinary: async () => ({ version: "8.0.47", skipped: true, restarted: false }),
};

describe("runInit", () => {
  it("creates exactly the one-time bootstrap before installing the latest binary", async () => {
    const layout = setup();
    let installed = false;
    const output = await captureConsole(() =>
      runInit({
        updateBinary: async (home, options) => {
          assert.equal(home, layout.home);
          assert.equal(fs.readFileSync(layout.configFile, "utf8"), EXPECTED_CONFIG);
          assert.equal(options?.version, undefined);
          assert.equal(options?.force, undefined);
          assert.equal(options?.insecure, undefined);
          assert.equal(Object.hasOwn(options ?? {}, "beforeInstall"), false);
          assert.equal(fs.existsSync(path.join(miniCpaRoot(), "state", "cpa.lock")), false);
          assert.ok(fs.existsSync(path.join(miniCpaRoot(), "state", "update", "cpa.lock")));
          installed = true;
          return { version: "8.0.47", skipped: false, restarted: false };
        },
      }),
    );
    assert.equal(installed, true);
    assert.deepEqual(output.stderr, []);
    assert.match(output.stdout.join("\n"), /CLIProxyAPI installed: 8\.0\.47/);
    assert.match(output.stdout.join("\n"), /Next:[\s\S]*cpa start[\s\S]*cpa web/);
    assert.doesNotMatch(output.stdout.join("\n"), /sk-cliproxyapi|CLIPROXYAPI/);
    assert.equal(fs.existsSync(path.join(layout.home, ".env")), false);
    assert.equal(fs.existsSync(path.join(layout.home, "backups")), false);
    assert.equal(fs.existsSync(layout.authsDir), false);
    assert.equal(fs.existsSync(layout.staticDir), false);
    assert.equal(fs.existsSync(layout.logsDir), false);
    assert.ok(fs.existsSync(layout.stateDir));
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(layout.configFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(layout.home).mode & 0o777, 0o700);
    }
  });

  it("never reads or rewrites existing configuration, credentials, env or backups", async () => {
    const layout = setup();
    const preserved = [
      layout.configFile,
      path.join(layout.home, ".env"),
      path.join(layout.authsDir, "credential.json"),
      path.join(layout.staticDir, "management.html"),
      path.join(layout.home, "backups", "config", "config.1.yaml"),
      `${layout.configFile}.bak.2026-10-01T12-34-56-789Z`,
      path.join(layout.home, ".config.yaml.replace.bak"),
    ];
    for (const [index, file] of preserved.entries()) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `opaque user content ${index}\n`, { mode: 0o644 });
    }
    const modes = preserved.map((file) => fs.statSync(file).mode);
    const originalRead = fs.readFileSync;
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      assert.equal(preserved.includes(String(file)), false, "MiniCPA must not read CPA files");
      return (originalRead as (...args: unknown[]) => unknown)(file, ...args);
    }) as typeof fs.readFileSync;
    try {
      await captureConsole(() => runInit(currentBinary));
      await captureConsole(() => runInit(currentBinary));
    } finally {
      fs.readFileSync = originalRead;
    }
    for (const [index, file] of preserved.entries()) {
      assert.equal(fs.readFileSync(file, "utf8"), `opaque user content ${index}\n`);
      assert.equal(fs.statSync(file).mode, modes[index]);
    }
  });

  it("preserves an existing empty or oversized config without validating it", async () => {
    const layout = setup();
    fs.mkdirSync(layout.home, { recursive: true });
    fs.writeFileSync(layout.configFile, "");
    await captureConsole(() => runInit(currentBinary));
    assert.equal(fs.statSync(layout.configFile).size, 0);
    fs.truncateSync(layout.configFile, 5 * 1024 * 1024);
    await captureConsole(() => runInit(currentBinary));
    assert.equal(fs.statSync(layout.configFile).size, 5 * 1024 * 1024);
  });

  it("preserves a config created by another writer at the exclusive creation boundary", async () => {
    const layout = setup();
    const originalOpen = fs.openSync;
    let inserted = false;
    fs.openSync = (file, ...args) => {
      if (String(file) === layout.configFile && !inserted) {
        inserted = true;
        const fd = originalOpen(file, "wx", 0o600);
        fs.writeFileSync(fd, "external config\n");
        fs.closeSync(fd);
      }
      return originalOpen(file, ...args);
    };
    try {
      await captureConsole(() => runInit(currentBinary));
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(inserted, true);
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "external config\n");
  });

  it("preserves the initial config on download failure and user edits on a retry", async () => {
    const layout = setup();
    await assert.rejects(
      () =>
        captureConsole(() =>
          runInit({
            updateBinary: async () => {
              throw new Error("download failed");
            },
          }),
        ),
      /download failed/,
    );
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), EXPECTED_CONFIG);
    fs.writeFileSync(layout.configFile, "user configuration after failed download\n");
    await captureConsole(() => runInit(currentBinary));
    assert.equal(
      fs.readFileSync(layout.configFile, "utf8"),
      "user configuration after failed download\n",
    );
    assert.equal(fs.existsSync(path.join(layout.home, ".env")), false);
  });

  it("reports a config flush failure without deleting a concurrent writer's contents", async () => {
    const layout = setup();
    const originalOpen = fs.openSync;
    const originalSync = fs.fsyncSync;
    let configFd: number | undefined;
    let installed = false;
    fs.openSync = (file, ...args) => {
      const fd = originalOpen(file, ...args);
      if (String(file) === layout.configFile) configFd = fd;
      return fd;
    };
    fs.fsyncSync = (fd) => {
      if (fd === configFd) {
        configFd = undefined;
        fs.writeFileSync(layout.configFile, "concurrent user configuration\n");
        throw new Error("config flush failed");
      }
      originalSync(fd);
    };
    try {
      await assert.rejects(
        () =>
          captureConsole(() =>
            runInit({
              updateBinary: async () => {
                installed = true;
                return currentBinary.updateBinary(layout.home);
              },
            }),
          ),
        /config flush failed/,
      );
    } finally {
      fs.openSync = originalOpen;
      fs.fsyncSync = originalSync;
    }
    assert.equal(installed, false);
    assert.equal(fs.readFileSync(layout.configFile, "utf8"), "concurrent user configuration\n");
  });
});
