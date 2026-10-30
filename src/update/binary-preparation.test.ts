import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  activeExecutablePath,
  cpaHome,
  cpaLayout,
  executableName,
  miniCpaRoot,
  miniCpaTempRoot,
} from "../paths.js";
import { withMiniCpaLock } from "../process/lock.js";
import { readInstallState, writeInstallState } from "../state.js";
import { createIsolatedTestEnv } from "../test-fixtures/test-env.js";
import { runClean } from "../commands/clean.js";
import { HttpStatusError } from "../http.js";
import { updateBinary, type BinaryPrepareDeps, type BinaryUpdateDeps } from "./binary.js";

let env: ReturnType<typeof createIsolatedTestEnv> | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});
type Runtime = { running: boolean; version: string };
function setup(running = true): {
  home: string;
  state: Runtime;
  deps: BinaryUpdateDeps & BinaryPrepareDeps;
  events: string[];
} {
  env = createIsolatedTestEnv("minicpa-update-prepare-");
  const home = cpaHome();
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(activeExecutablePath(home), "old-binary");
  fs.writeFileSync(cpaLayout(home).configFile, "port: 8317\ndebug: true\n");
  writeInstallState(home, { runtimeVersion: "1.0.0" });
  const state = { running, version: "1.0.0" };
  const events: string[] = [];
  const preparation = (name: string): void => {
    assert.equal(
      fs.existsSync(path.join(miniCpaRoot(), "state", "cpa.lock")),
      false,
      `${name} must not hold lifecycle lock`,
    );
    events.push(name);
  };
  const deps: BinaryUpdateDeps & BinaryPrepareDeps = {
    fetchLatestRelease: async () => {
      preparation("release");
      return { tag: "v2.0.0" };
    },
    fetchCpaReleaseByTag: async () => {
      throw new Error("not used");
    },
    downloadToFile: async (_url, destination) => {
      preparation("download");
      fs.writeFileSync(destination, "archive");
    },
    fetchChecksums: async () => {
      preparation("checksum");
      return new Map();
    },
    extractArchive: async (_archive, destination) => {
      preparation("extract");
      fs.mkdirSync(destination, { recursive: true });
      const file = path.join(destination, executableName());
      fs.writeFileSync(file, "new-binary");
      return file;
    },
    readCurrentRuntimeVersion: async () => {
      assert.ok(fs.existsSync(path.join(miniCpaRoot(), "state", "cpa.lock")));
      events.push("version");
      return state.version;
    },
    resolveRunning: async () => {
      events.push("resolve");
      return state.running ? { pid: 12345, exe: activeExecutablePath(home) } : undefined;
    },
    stopDaemon: async () => {
      events.push("stop");
      state.running = false;
      return true;
    },
    startDaemon: async () => {
      events.push("start");
      state.running = true;
      return { pid: 12345, exe: activeExecutablePath(home) };
    },
  };
  return { home, state, deps, events };
}

function blockDownload(deps: BinaryPrepareDeps): { ready: Promise<void>; release: () => void } {
  const original = deps.downloadToFile;
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  deps.downloadToFile = async (...args) => {
    await original(...args);
    entered();
    await blocked;
  };
  return { ready, release };
}

describe("binary preparation and commit", () => {
  it("copies and fsyncs on the target volume before stop or the lifecycle lock", async () => {
    const { home, deps, events, state } = setup();
    const originalCopy = fs.copyFileSync;
    const originalOpen = fs.openSync;
    const originalSync = fs.fsyncSync;
    let stagedFd: number | undefined;
    fs.copyFileSync = (source, destination, mode) => {
      if (String(destination) === `${activeExecutablePath(home)}.new`) {
        assert.equal(state.running, true);
        assert.equal(fs.existsSync(path.join(miniCpaRoot(), "state", "cpa.lock")), false);
        events.push("copy");
      }
      originalCopy(source, destination, mode);
    };
    fs.openSync = (file, ...args) => {
      const fd = originalOpen(file, ...args);
      if (String(file) === `${activeExecutablePath(home)}.new`) stagedFd = fd;
      return fd;
    };
    fs.fsyncSync = (fd) => {
      if (fd === stagedFd) {
        assert.equal(fs.existsSync(path.join(miniCpaRoot(), "state", "cpa.lock")), false);
        events.push("fsync");
        stagedFd = undefined;
      }
      originalSync(fd);
    };
    try {
      const result = await updateBinary(home, {
        insecure: true,
        deps,
      });
      assert.equal(result.restarted, true);
    } finally {
      fs.copyFileSync = originalCopy;
      fs.openSync = originalOpen;
      fs.fsyncSync = originalSync;
    }
    assert.ok(events.indexOf("extract") < events.indexOf("copy"));
    assert.ok(events.indexOf("copy") < events.indexOf("fsync"));
    assert.ok(events.indexOf("fsync") < events.indexOf("stop"));
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "new-binary");
    assert.equal(readInstallState(home).runtimeVersion, "2.0.0");
    assert.equal(fs.existsSync(`${activeExecutablePath(home)}.new`), false);
    assert.deepEqual(fs.readdirSync(path.join(miniCpaTempRoot(), "operations")), []);
  });

  it("respects a user stop during download, excludes duplicate updates and protects staging from clean", async () => {
    const { home, deps, state, events } = setup();
    const network = blockDownload(deps);
    const updating = updateBinary(home, { insecure: true, deps });
    await network.ready;
    try {
      await withMiniCpaLock("stop", async () => {
        state.running = false;
      });
      await assert.rejects(() => runClean({ minAgeMs: 0 }), /lock|running/i);
      await assert.rejects(() => updateBinary(home, { insecure: true, deps }), /lock|running/i);
    } finally {
      network.release();
    }
    const result = await updating;
    assert.equal(result.restarted, false);
    assert.equal(events.includes("stop"), false);
    assert.equal(events.includes("start"), false);
    assert.equal(events.filter((event) => event === "download").length, 1);
  });

  it("respects a user start during download and restarts only that currently running instance", async () => {
    const { home, deps, state, events } = setup(false);
    const network = blockDownload(deps);
    const updating = updateBinary(home, { insecure: true, deps });
    await network.ready;
    try {
      await withMiniCpaLock("start", async () => {
        state.running = true;
      });
    } finally {
      network.release();
    }
    assert.equal((await updating).restarted, true);
    assert.equal(events.filter((event) => event === "stop").length, 1);
    assert.equal(events.filter((event) => event === "start").length, 1);
  });

  it("never stops or changes config when checksum preparation fails", async () => {
    const { home, deps, events } = setup();
    const old = fs.readFileSync(cpaLayout(home).configFile, "utf8");
    await assert.rejects(() => updateBinary(home, { deps }), /No checksums available/);
    assert.equal(events.includes("stop"), false);
    assert.equal(fs.readFileSync(cpaLayout(home).configFile, "utf8"), old);
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "old-binary");
  });

  it("skips downloads without synchronizing an already-current config", async () => {
    const { home, deps, events, state } = setup();
    state.version = "2.0.0";
    writeInstallState(home, { runtimeVersion: state.version });
    const result = await updateBinary(home, { deps });
    assert.equal(result.skipped, true);
    assert.equal(events.includes("download"), false);
    assert.equal(events.includes("stop"), false);
    assert.equal(fs.readFileSync(cpaLayout(home).configFile, "utf8"), "port: 8317\ndebug: true\n");
  });

  it("clears orphaned workspaces even when recent or already up to date", async () => {
    const { home, deps, state } = setup();
    const orphan = path.join(miniCpaTempRoot(), "operations", "update-orphan");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "archive"), "leftover");
    state.version = "2.0.0";
    writeInstallState(home, { runtimeVersion: state.version });
    assert.equal((await updateBinary(home, { deps })).skipped, true);
    assert.equal(fs.existsSync(orphan), false);
  });

  it("refuses another workspace when an old operation cannot be deleted", async () => {
    const { home, deps, events } = setup();
    const orphan = path.join(miniCpaTempRoot(), "operations", "update-locked");
    fs.mkdirSync(orphan, { recursive: true });
    const originalRm = fs.promises.rm;
    fs.promises.rm = async (file, options) => {
      if (String(file) === orphan) throw new Error("busy archive");
      return originalRm(file, options);
    };
    try {
      await assert.rejects(
        () => updateBinary(home, { insecure: true, deps }),
        /Could not clear previous update operation/,
      );
      await assert.rejects(
        () => updateBinary(home, { insecure: true, deps }),
        /Could not clear previous update operation/,
      );
    } finally {
      fs.promises.rm = originalRm;
    }
    assert.deepEqual(events, []);
    assert.deepEqual(fs.readdirSync(path.dirname(orphan)), ["update-locked"]);
  });

  it("leaves config validation to CPA instead of inspecting it before replacement", async () => {
    const { home, deps, events } = setup();
    const config = cpaLayout(home).configFile;
    fs.writeFileSync(config, "port: [broken\n");
    assert.equal((await updateBinary(home, { insecure: true, deps })).restarted, true);
    assert.equal(events.includes("stop"), true);
    assert.equal(fs.readFileSync(config, "utf8"), "port: [broken\n");
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "new-binary");
    assert.equal(fs.existsSync(`${activeExecutablePath(home)}.new`), false);
  });

  it("restores the previous binary without rewriting config before the recovery restart", async () => {
    const { home, deps, state } = setup();
    const config = cpaLayout(home).configFile;
    const old = fs.readFileSync(config, "utf8");
    let starts = 0;
    deps.startDaemon = async () => {
      state.running = true;
      if (++starts === 1) throw new Error("new version not ready");
      assert.equal(fs.readFileSync(config, "utf8"), old);
      assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "old-binary");
      return { pid: 12345, exe: activeExecutablePath(home) };
    };
    await assert.rejects(
      () => updateBinary(home, { insecure: true, deps }),
      /new version not ready/,
    );
    assert.equal(starts, 2);
    assert.equal(readInstallState(home).runtimeVersion, "1.0.0");
  });

  it("preserves native config changes during binary rollback", async () => {
    const { home, deps, state } = setup();
    const config = cpaLayout(home).configFile;
    let starts = 0;
    deps.startDaemon = async () => {
      state.running = true;
      if (++starts === 1) {
        fs.writeFileSync(config, "port: 12345\n# external edit\n");
        throw new Error("not ready");
      }
      return { pid: 12345, exe: activeExecutablePath(home) };
    };
    await assert.rejects(() => updateBinary(home, { insecure: true, deps }), /not ready/);
    assert.equal(fs.readFileSync(config, "utf8"), "port: 12345\n# external edit\n");
    assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "old-binary");
  });

  it("falls back to the next candidate asset ONLY on typed HttpStatusError(404)", async () => {
    const originalArch = process.arch;
    Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
    try {
      const { home, deps } = setup();
      let downloads = 0;
      deps.downloadToFile = async (_url, destination) => {
        downloads++;
        if (downloads === 1) {
          throw new HttpStatusError(404, "Download failed 404: asset not found");
        }
        fs.writeFileSync(destination, "archive");
      };
      const result = await updateBinary(home, { insecure: true, deps });
      assert.equal(downloads, 2, "second candidate should have been downloaded");
      assert.equal(result.restarted, true);
      assert.equal(fs.readFileSync(activeExecutablePath(home), "utf8"), "new-binary");
    } finally {
      Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
    }
  });

  it("does not fall back to the next candidate on a generic misleading 'Download failed 404' Error", async () => {
    const originalArch = process.arch;
    Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
    try {
      const { home, deps } = setup();
      let downloads = 0;
      deps.downloadToFile = async (_url, destination) => {
        downloads++;
        if (downloads === 1) {
          throw new Error("Download failed 404: misleading text without HttpStatusError");
        }
        fs.writeFileSync(destination, "archive");
      };
      await assert.rejects(
        () => updateBinary(home, { insecure: true, deps }),
        /misleading text without HttpStatusError/,
      );
      assert.equal(downloads, 1, "must not attempt next candidate on non-HttpStatusError");
    } finally {
      Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
    }
  });

  it("does not fall back on a non-404 HttpStatusError", async () => {
    const originalArch = process.arch;
    Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
    try {
      const { home, deps } = setup();
      let downloads = 0;
      deps.downloadToFile = async (_url, destination) => {
        downloads++;
        if (downloads === 1) {
          throw new HttpStatusError(500, "Download failed 500: internal server error");
        }
        fs.writeFileSync(destination, "archive");
      };
      await assert.rejects(
        () => updateBinary(home, { insecure: true, deps }),
        (err: unknown) => {
          assert.ok(err instanceof HttpStatusError);
          assert.equal(err.status, 500);
          return true;
        },
      );
      assert.equal(downloads, 1, "must not attempt next candidate on 500");
    } finally {
      Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
    }
  });

  it("propagates typed 404 HttpStatusError from pinned release tag lookups without fallback", async () => {
    const { home, deps } = setup();
    deps.fetchCpaReleaseByTag = async (tag) => {
      throw new HttpStatusError(404, `Release not found: ${tag}`);
    };
    await assert.rejects(
      () => updateBinary(home, { version: "v9.9.9", deps }),
      (err: unknown) => {
        assert.ok(err instanceof HttpStatusError);
        assert.equal(err.status, 404);
        assert.match(err.message, /Release not found: v9\.9\.9/);
        return true;
      },
    );
  });
});
