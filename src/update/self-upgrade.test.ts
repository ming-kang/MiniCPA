import assert from "node:assert/strict";
import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  classifyNpmGlobalRoot,
  detectNpmGlobalInstall,
  inferNpmGlobalRoot,
  installMinicpaVersion,
  type CaptureCommand,
  type SpawnCommand,
  type SupportedNpmGlobalInstall,
} from "./self-upgrade.js";

const tempDirectories: string[] = [];
const testPlatform = process.platform;

async function makeGlobalInstall(prefixName = "prefix with spaces"): Promise<{
  prefix: string;
  globalRoot: string;
  packageRoot: string;
}> {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "minicpa-self-upgrade-"));
  tempDirectories.push(temp);
  const prefix = path.join(temp, prefixName);
  const globalRoot =
    testPlatform === "win32"
      ? path.join(prefix, "node_modules")
      : path.join(prefix, "lib", "node_modules");
  const packageRoot = path.join(globalRoot, "@astralyn", "minicpa");
  const cliPath = path.join(packageRoot, "dist", "cli.js");
  await fs.mkdir(path.dirname(cliPath), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@astralyn/minicpa", version: "1.0.0" }),
  );
  await fs.writeFile(cliPath, "#!/usr/bin/env node\n");
  if (testPlatform === "win32") {
    await fs.writeFile(
      path.join(prefix, "cpa.cmd"),
      '@node "%~dp0\\node_modules\\@astralyn\\minicpa\\dist\\cli.js" %*\r\n',
    );
  } else {
    const binDir = path.join(prefix, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.symlink(path.relative(binDir, cliPath), path.join(binDir, "cpa"));
  }
  return { prefix, globalRoot, packageRoot };
}

function captureRoot(globalRoot: string): CaptureCommand {
  return async (command, args, options) => {
    assert.equal(command, testPlatform === "win32" ? "npm.cmd" : "npm");
    const layout = classifyNpmGlobalRoot(globalRoot, testPlatform);
    assert.equal(layout.supported, true);
    assert.deepEqual(args, ["--prefix", layout.prefix, "root", "-g"]);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    return { status: 0, signal: null, stdout: `${globalRoot}\n`, stderr: "" };
  };
}

function supportedInstall(prefix = "/global prefix"): SupportedNpmGlobalInstall {
  return {
    supported: true,
    prefix,
    globalRoot: `${prefix}/lib/node_modules`,
    expectedPackageRoot: `${prefix}/lib/node_modules/@astralyn/minicpa`,
    npmCommand: "npm",
  };
}

function closingSpawn(
  status: number | null,
  signal: NodeJS.Signals | null = null,
  inspect?: (command: string, args: string[], options: SpawnOptions) => void,
): SpawnCommand {
  return ((command: string, args: string[], options: SpawnOptions) => {
    inspect?.(command, args, options);
    const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null };
    child.stdout = null;
    child.stderr = null;
    process.nextTick(() => child.emit("close", status, signal));
    return child;
  }) as SpawnCommand;
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe("classifyNpmGlobalRoot", () => {
  it("classifies standard and custom POSIX prefixes", () => {
    assert.deepEqual(classifyNpmGlobalRoot("/usr/local/lib/node_modules", "linux"), {
      supported: true,
      prefix: "/usr/local",
      globalRoot: "/usr/local/lib/node_modules",
    });
    assert.deepEqual(classifyNpmGlobalRoot("/opt/My Prefix/lib/node_modules", "darwin"), {
      supported: true,
      prefix: "/opt/My Prefix",
      globalRoot: "/opt/My Prefix/lib/node_modules",
    });
  });

  it("purely classifies Windows global and local-looking paths", () => {
    assert.deepEqual(classifyNpmGlobalRoot("C:\\Users\\A User\\npm\\node_modules", "win32"), {
      supported: true,
      prefix: "C:\\Users\\A User\\npm",
      globalRoot: "C:\\Users\\A User\\npm\\node_modules",
    });
    assert.equal(classifyNpmGlobalRoot("C:\\repo\\packages", "win32").supported, false);
    assert.equal(classifyNpmGlobalRoot("C:\\node_modules", "win32").supported, false);
  });

  it("infers direct scoped-package roots without accepting POSIX local installs", () => {
    assert.deepEqual(
      inferNpmGlobalRoot("/opt/custom/lib/node_modules/@astralyn/minicpa", "linux"),
      {
        supported: true,
        prefix: "/opt/custom",
        globalRoot: "/opt/custom/lib/node_modules",
      },
    );
    assert.equal(
      inferNpmGlobalRoot("/repo/node_modules/@astralyn/minicpa", "linux").supported,
      false,
    );
    assert.deepEqual(
      inferNpmGlobalRoot("C:\\Users\\A User\\npm\\node_modules\\@astralyn\\minicpa", "win32"),
      {
        supported: true,
        prefix: "C:\\Users\\A User\\npm",
        globalRoot: "C:\\Users\\A User\\npm\\node_modules",
      },
    );
  });
});

describe("detectNpmGlobalInstall", () => {
  it("proves a direct POSIX global install when only an ancestor path canonicalizes", async () => {
    const prefix = "/opt/MiniCPA Custom";
    const globalRoot = `${prefix}/lib/node_modules`;
    const packageRoot = `${globalRoot}/@astralyn/minicpa`;
    const result = await detectNpmGlobalInstall(packageRoot, {
      platform: "linux",
      env: { PATH: "/usr/bin" },
      capture: async (command, args) => {
        assert.equal(command, "npm");
        assert.deepEqual(args, ["--prefix", prefix, "root", "-g"]);
        return { status: 0, signal: null, stdout: globalRoot, stderr: "" };
      },
      fs: {
        readFile: async (filePath) => {
          assert.equal(filePath, `${packageRoot}/package.json`);
          return JSON.stringify({ name: "@astralyn/minicpa" });
        },
        realpath: async (filePath) => {
          if (filePath === `${prefix}/bin/cpa`) return `${packageRoot}/dist/cli.js`;
          // macOS `/var` -> `/private/var` and Windows 8.3 paths can canonicalize
          // ancestors without the package entry itself being a link/junction.
          if (filePath === packageRoot) return `/canonical${packageRoot}`;
          return filePath;
        },
        lstat: async (filePath) => {
          if (filePath === packageRoot || filePath === `${prefix}/bin/cpa`) {
            return {
              isDirectory: () => filePath === packageRoot,
              isSymbolicLink: () => filePath !== packageRoot,
            };
          }
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        },
        access: async () => {},
      },
    });
    assert.deepEqual(result, {
      supported: true,
      prefix,
      globalRoot,
      expectedPackageRoot: packageRoot,
      npmCommand: "npm",
    });
  });

  it("proves a direct global install with a prefix containing spaces", async () => {
    const installation = await makeGlobalInstall();
    const result = await detectNpmGlobalInstall(installation.packageRoot, {
      platform: testPlatform,
      capture: captureRoot(installation.globalRoot),
      env: {
        PATH: "/usr/bin",
        HTTPS_PROXY: "http://proxy.example",
        npm_token: "secret",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
    });

    assert.deepEqual(result, {
      supported: true,
      prefix: installation.prefix,
      globalRoot: installation.globalRoot,
      expectedPackageRoot: installation.packageRoot,
      npmCommand: testPlatform === "win32" ? "npm.cmd" : "npm",
    });
  });

  it("rejects a local-looking node_modules tree that has no npm-global cpa shim", async () => {
    const installation = await makeGlobalInstall("ambiguous-local-tree");
    const binPath =
      testPlatform === "win32"
        ? path.join(installation.prefix, "cpa.cmd")
        : path.join(installation.prefix, "bin", "cpa");
    await fs.rm(binPath, { force: true });

    const result = await detectNpmGlobalInstall(installation.packageRoot, {
      platform: testPlatform,
      capture: captureRoot(installation.globalRoot),
    });

    assert.equal(result.supported, false);
    if (!result.supported) {
      assert.equal(result.reason, "not-global");
      assert.match(result.message, /global cpa shim/);
    }
  });

  it("strips tokens but preserves PATH, proxy, and TLS settings for npm root", async () => {
    const installation = await makeGlobalInstall();
    const result = await detectNpmGlobalInstall(installation.packageRoot, {
      platform: testPlatform,
      env: {
        PATH: "/custom/bin",
        HTTPS_PROXY: "http://proxy.example",
        Gh_ToKeN: "secret",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
      capture: async (_command, _args, options) => {
        assert.equal(options.env.PATH, "/custom/bin");
        assert.equal(options.env.HTTPS_PROXY, "http://proxy.example");
        assert.equal(options.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
        assert.equal(options.env.Gh_ToKeN, undefined);
        return { status: 0, signal: null, stdout: installation.globalRoot, stderr: "" };
      },
    });
    assert.equal(result.supported, true);
  });

  it("rejects npx, local/source, linked, and pnpm installations", async () => {
    const installation = await makeGlobalInstall();
    const npx = await detectNpmGlobalInstall("/tmp/_npx/123/node_modules/@astralyn/minicpa", {
      platform: testPlatform,
      capture: async () => assert.fail("npx must be rejected before npm is run"),
    });
    assert.equal(npx.supported, false);
    if (!npx.supported) assert.equal(npx.reason, "npx");

    const localRoot = path.join(path.dirname(installation.prefix), "source", "node_modules");
    const localPackage = path.join(localRoot, "@astralyn", "minicpa");
    await fs.mkdir(localPackage, { recursive: true });
    await fs.writeFile(
      path.join(localPackage, "package.json"),
      JSON.stringify({ name: "@astralyn/minicpa" }),
    );
    const local = await detectNpmGlobalInstall(localPackage, {
      platform: testPlatform,
      capture: async () => ({
        status: 0,
        signal: null,
        stdout: installation.globalRoot,
        stderr: "",
      }),
    });
    assert.equal(local.supported, false);
    if (!local.supported) assert.equal(local.reason, "not-global");

    const linked = await detectNpmGlobalInstall(installation.packageRoot, {
      platform: testPlatform,
      capture: captureRoot(installation.globalRoot),
      fs: {
        readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
        realpath: (filePath) => fs.realpath(filePath),
        lstat: async (filePath) => {
          const stat = await fs.lstat(filePath);
          if (filePath !== installation.packageRoot) return stat;
          return { isDirectory: () => true, isSymbolicLink: () => true };
        },
        access: (filePath, mode) => fs.access(filePath, mode),
      },
    });
    assert.equal(linked.supported, false);
    if (!linked.supported) assert.equal(linked.reason, "linked");

    for (const managerRoot of [".pnpm", ".yarn", ".bun"]) {
      const managed = await detectNpmGlobalInstall(`/tmp/${managerRoot}/@astralyn/minicpa`, {
        platform: testPlatform,
      });
      assert.equal(managed.supported, false);
      if (!managed.supported) assert.equal(managed.reason, "other-package-manager");
    }
  });

  it("rejects a project prefix, an unwritable prefix, and npm ENOENT", async () => {
    const project = await makeGlobalInstall("project-prefix");
    await fs.writeFile(path.join(project.prefix, "package.json"), "{}");
    const projectResult = await detectNpmGlobalInstall(project.packageRoot, {
      platform: testPlatform,
      capture: captureRoot(project.globalRoot),
    });
    assert.equal(projectResult.supported, false);
    if (!projectResult.supported) assert.equal(projectResult.reason, "project-prefix");

    const installation = await makeGlobalInstall("unwritable");
    const unwritableResult = await detectNpmGlobalInstall(installation.packageRoot, {
      platform: testPlatform,
      capture: captureRoot(installation.globalRoot),
      fs: {
        readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
        realpath: (filePath) => fs.realpath(filePath),
        lstat: (filePath) => fs.lstat(filePath),
        access: async () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      },
    });
    assert.equal(unwritableResult.supported, false);
    if (!unwritableResult.supported) assert.equal(unwritableResult.reason, "not-writable");

    const missingNpm = await detectNpmGlobalInstall(installation.packageRoot, {
      platform: testPlatform,
      capture: async () => {
        throw Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
      },
    });
    assert.equal(missingNpm.supported, false);
    if (!missingNpm.supported) assert.equal(missingNpm.reason, "npm-unavailable");
  });
});

describe("installMinicpaVersion", () => {
  it("uses fixed safe npm arguments and a credential-safe inherited environment", async () => {
    const detection = supportedInstall();
    await installMinicpaVersion(detection, "2.3.4", {
      env: {
        PATH: "/custom/bin",
        https_proxy: "http://proxy.example",
        NpM_ToKeN: "secret",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
      spawn: closingSpawn(0, null, (command, args, options) => {
        assert.equal(command, "npm");
        assert.deepEqual(args, [
          "--prefix",
          "/global prefix",
          "install",
          "--global",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--registry=https://registry.npmjs.org",
          "@astralyn/minicpa@2.3.4",
        ]);
        assert.equal(options.shell, false);
        assert.equal(options.stdio, "inherit");
        assert.equal(options.windowsHide, true);
        assert.equal(options.env?.PATH, "/custom/bin");
        assert.equal(options.env?.https_proxy, "http://proxy.example");
        assert.equal(options.env?.NpM_ToKeN, undefined);
        assert.equal(options.env?.NODE_TLS_REJECT_UNAUTHORIZED, "0");
      }),
      readFile: async () => JSON.stringify({ name: "@astralyn/minicpa", version: "2.3.4" }),
    });
  });

  it("reports nonzero npm exits with a manual recovery command", async () => {
    const detection = supportedInstall();
    await assert.rejects(
      installMinicpaVersion(detection, "2.3.4", { spawn: closingSpawn(17) }),
      (error: Error) => {
        assert.match(error.message, /status 17/);
        assert.match(error.message, /npm --prefix "\/global prefix" install --global/);
        assert.match(error.message, /@astralyn\/minicpa@2\.3\.4/);
        return true;
      },
    );
  });

  it("rejects an ENOENT spawn and signaled npm with actionable errors", async () => {
    const detection = supportedInstall();
    const missingSpawn = (() => {
      return () => {
        const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null };
        child.stdout = null;
        child.stderr = null;
        process.nextTick(() =>
          child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
        );
        return child;
      };
    })() as SpawnCommand;
    await assert.rejects(
      installMinicpaVersion(detection, "2.3.4", { spawn: missingSpawn }),
      /was not found[\s\S]*Retry manually/,
    );
    await assert.rejects(
      installMinicpaVersion(detection, "2.3.4", { spawn: closingSpawn(null, "SIGTERM") }),
      /terminated by signal SIGTERM[\s\S]*Retry manually/,
    );
  });

  it("strictly verifies the installed manifest and succeeds only on an exact match", async () => {
    const detection = supportedInstall();
    await assert.rejects(
      installMinicpaVersion(detection, "2.3.4", {
        spawn: closingSpawn(0),
        readFile: async () => JSON.stringify({ name: "@astralyn/minicpa", version: "2.3.5" }),
      }),
      /post-install verification expected/,
    );

    await installMinicpaVersion(detection, "2.3.4-beta.1", {
      spawn: closingSpawn(0),
      readFile: async () => JSON.stringify({ name: "@astralyn/minicpa", version: "2.3.4-beta.1" }),
    });
  });

  it("rejects tags, ranges, paths, and non-canonical versions before spawning", async () => {
    let spawned = false;
    const fakeSpawn = (() => {
      spawned = true;
      throw new Error("must not spawn");
    }) as SpawnCommand;
    for (const version of ["latest", "^2.3.4", "../package", "v2.3.4", "02.3.4"]) {
      await assert.rejects(
        installMinicpaVersion(supportedInstall(), version, { spawn: fakeSpawn }),
        /non-canonical/,
      );
    }
    assert.equal(spawned, false);
  });
});
