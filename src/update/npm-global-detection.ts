import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import spawn from "cross-spawn";
import { buildCredentialSafeChildEnv } from "../process/child-env.js";
import { MINICPA_PACKAGE_NAME } from "./minicpa-release.js";

export type SupportedNpmGlobalInstall = {
  supported: true;
  prefix: string;
  globalRoot: string;
  expectedPackageRoot: string;
  npmCommand: "npm" | "npm.cmd";
};

export type UnsupportedNpmGlobalInstall = {
  supported: false;
  reason:
    | "invalid-package"
    | "npx"
    | "linked"
    | "npm-unavailable"
    | "npm-root-failed"
    | "unsupported-layout"
    | "not-global"
    | "project-prefix"
    | "other-package-manager"
    | "source-install"
    | "not-writable"
    | "filesystem-error";
  message: string;
};

export type NpmGlobalInstallDetection = SupportedNpmGlobalInstall | UnsupportedNpmGlobalInstall;

export type GlobalRootLayout =
  | { supported: true; prefix: string; globalRoot: string }
  | { supported: false; message: string };

type Platform = NodeJS.Platform;

type FileStat = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

type FileSystem = {
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  realpath(filePath: string): Promise<string>;
  lstat(filePath: string): Promise<FileStat>;
  access(filePath: string, mode: number): Promise<void>;
};

type CommandOptions = {
  shell: false;
  windowsHide: true;
  env: NodeJS.ProcessEnv;
};

export type CapturedCommand = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type CaptureCommand = (
  command: string,
  args: string[],
  options: CommandOptions,
) => Promise<CapturedCommand>;

export type SelfUpgradeDetectionDependencies = {
  platform: Platform;
  fs: FileSystem;
  capture: CaptureCommand;
  env: NodeJS.ProcessEnv;
};

export type NpmGlobalInstallDetectionOptions = {
  requireWritable?: boolean;
};

function pathApi(platform: Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function comparablePath(value: string, platform: Platform): string {
  const api = pathApi(platform);
  const resolved = api.resolve(value);
  const root = api.parse(resolved).root;
  const withoutTrailingSeparators = resolved === root ? resolved : resolved.replace(/[\\/]+$/, "");
  return platform === "win32" ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators;
}

function hasPathPart(filePath: string, part: string, platform: Platform): boolean {
  const api = pathApi(platform);
  const target = part.toLowerCase();
  let current = api.resolve(filePath);
  while (true) {
    if (api.basename(current).toLowerCase() === target) return true;
    const parent = api.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Pure classification of layouts emitted by `npm root -g`. */
export function classifyNpmGlobalRoot(globalRoot: string, platform: Platform): GlobalRootLayout {
  const api = pathApi(platform);
  if (!api.isAbsolute(globalRoot)) {
    return { supported: false, message: "npm root -g returned a non-absolute path." };
  }

  const resolvedRoot = api.resolve(globalRoot);
  if (platform === "win32") {
    if (api.basename(resolvedRoot).toLowerCase() !== "node_modules") {
      return {
        supported: false,
        message: "npm root -g did not return the Windows <prefix>/node_modules layout.",
      };
    }
    const prefix = api.dirname(resolvedRoot);
    if (prefix === resolvedRoot || prefix === api.parse(resolvedRoot).root) {
      return { supported: false, message: "npm root -g returned an unsafe global prefix." };
    }
    return { supported: true, prefix, globalRoot: resolvedRoot };
  }

  if (
    api.basename(resolvedRoot) !== "node_modules" ||
    api.basename(api.dirname(resolvedRoot)) !== "lib"
  ) {
    return {
      supported: false,
      message: "npm root -g did not return the POSIX <prefix>/lib/node_modules layout.",
    };
  }
  const prefix = api.dirname(api.dirname(resolvedRoot));
  if (prefix === resolvedRoot) {
    return { supported: false, message: "npm root -g returned an unsafe global prefix." };
  }
  return { supported: true, prefix, globalRoot: resolvedRoot };
}

/** Infer the only direct npm-global layout that could contain this scoped package. */
export function inferNpmGlobalRoot(packageRoot: string, platform: Platform): GlobalRootLayout {
  const api = pathApi(platform);
  const resolvedPackageRoot = api.resolve(packageRoot);
  const scopeRoot = api.dirname(resolvedPackageRoot);
  const globalRoot = api.dirname(scopeRoot);
  if (
    api.basename(resolvedPackageRoot).toLowerCase() !== "minicpa" ||
    api.basename(scopeRoot).toLowerCase() !== "@astralyn" ||
    api.basename(globalRoot).toLowerCase() !== "node_modules"
  ) {
    return {
      supported: false,
      message: "MiniCPA is not at a direct @astralyn/minicpa node_modules path.",
    };
  }
  return classifyNpmGlobalRoot(globalRoot, platform);
}

async function defaultCapture(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<CapturedCommand> {
  return await new Promise<CapturedCommand>((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

const defaultFileSystem: FileSystem = {
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  realpath: (filePath) => fs.realpath(filePath),
  lstat: (filePath) => fs.lstat(filePath),
  access: (filePath, mode) => fs.access(filePath, mode),
};

function unsupported(
  reason: UnsupportedNpmGlobalInstall["reason"],
  message: string,
): UnsupportedNpmGlobalInstall {
  return { supported: false, reason, message };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function pathExists(filePath: string, fileSystem: FileSystem): Promise<boolean> {
  try {
    await fileSystem.lstat(filePath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function readManifest(
  manifestPath: string,
  fileSystem: Pick<FileSystem, "readFile">,
): Promise<{ name?: unknown; version?: unknown }> {
  const raw = await fileSystem.readFile(manifestPath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as { name?: unknown; version?: unknown };
}

function oneOutputLine(stdout: string): string | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length === 1 ? lines[0] : undefined;
}

function globalBinPath(prefix: string, platform: Platform): string {
  const api = pathApi(platform);
  return platform === "win32" ? api.join(prefix, "cpa.cmd") : api.join(prefix, "bin", "cpa");
}

async function globalBinTargetsPackage(
  prefix: string,
  packageRoot: string,
  platform: Platform,
  fileSystem: FileSystem,
): Promise<boolean> {
  const api = pathApi(platform);
  const binPath = globalBinPath(prefix, platform);
  try {
    await fileSystem.lstat(binPath);
    if (platform === "win32") {
      const wrapper = (await fileSystem.readFile(binPath, "utf8"))
        .replaceAll("/", "\\")
        .toLowerCase();
      return wrapper.includes("node_modules\\@astralyn\\minicpa\\dist\\cli.js");
    }
    const [realBin, realCli] = await Promise.all([
      fileSystem.realpath(binPath),
      fileSystem.realpath(api.join(packageRoot, "dist", "cli.js")),
    ]);
    return comparablePath(realBin, platform) === comparablePath(realCli, platform);
  } catch {
    return false;
  }
}

/**
 * Prove that packageRoot is a direct npm global installation. Ambiguous layouts are rejected.
 * This function never mutates the installation and only invokes `npm root -g`.
 * Callers that only need a stable launcher may skip the write-access checks.
 */
export async function detectNpmGlobalInstall(
  packageRoot: string,
  dependencies: Partial<SelfUpgradeDetectionDependencies> = {},
  options: NpmGlobalInstallDetectionOptions = {},
): Promise<NpmGlobalInstallDetection> {
  const platform = dependencies.platform ?? process.platform;
  const fileSystem = dependencies.fs ?? defaultFileSystem;
  const capture = dependencies.capture ?? defaultCapture;
  const env = dependencies.env ?? process.env;
  const api = pathApi(platform);
  const resolvedPackageRoot = api.resolve(packageRoot);

  if (hasPathPart(resolvedPackageRoot, "_npx", platform)) {
    return unsupported("npx", "npx cache installations are not stable npm-global installs.");
  }
  const otherManagerParts = [".pnpm", "pnpm-global", ".yarn", ".bun"];
  if (otherManagerParts.some((part) => hasPathPart(resolvedPackageRoot, part, platform))) {
    return unsupported(
      "other-package-manager",
      "This installation appears to be managed by pnpm, Yarn, or Bun.",
    );
  }

  try {
    const manifest = await readManifest(api.join(resolvedPackageRoot, "package.json"), fileSystem);
    if (manifest.name !== MINICPA_PACKAGE_NAME) {
      return unsupported(
        "invalid-package",
        `Expected ${resolvedPackageRoot}/package.json to name ${MINICPA_PACKAGE_NAME}.`,
      );
    }
  } catch (error) {
    return unsupported(
      "invalid-package",
      `Cannot read a valid MiniCPA package.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const npmCommand = platform === "win32" ? "npm.cmd" : "npm";
  const inferredLayout = inferNpmGlobalRoot(resolvedPackageRoot, platform);
  const rootArgs = inferredLayout.supported
    ? ["--prefix", inferredLayout.prefix, "root", "-g"]
    : ["root", "-g"];
  let rootResult: CapturedCommand;
  try {
    rootResult = await capture(npmCommand, rootArgs, {
      shell: false,
      windowsHide: true,
      env: buildCredentialSafeChildEnv(env),
    });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return unsupported("npm-unavailable", `${npmCommand} is unavailable; install npm and retry.`);
    }
    return unsupported(
      "npm-root-failed",
      `Unable to run ${npmCommand} root -g: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (rootResult.status !== 0 || rootResult.signal !== null) {
    const outcome = rootResult.signal
      ? `terminated by ${rootResult.signal}`
      : `exited with status ${String(rootResult.status)}`;
    return unsupported("npm-root-failed", `${npmCommand} root -g ${outcome}.`);
  }

  const rootOutput = oneOutputLine(rootResult.stdout);
  if (rootOutput === undefined) {
    return unsupported("npm-root-failed", `${npmCommand} root -g returned an ambiguous path.`);
  }
  const layout = classifyNpmGlobalRoot(rootOutput, platform);
  if (!layout.supported) return unsupported("unsupported-layout", layout.message);
  if (
    inferredLayout.supported &&
    comparablePath(inferredLayout.globalRoot, platform) !==
      comparablePath(layout.globalRoot, platform)
  ) {
    return unsupported(
      "not-global",
      "npm did not confirm the global root inferred from this MiniCPA installation.",
    );
  }

  const expectedPackageRoot = api.join(layout.globalRoot, "@astralyn", "minicpa");
  if (
    comparablePath(resolvedPackageRoot, platform) !== comparablePath(expectedPackageRoot, platform)
  ) {
    try {
      const expectedStat = await fileSystem.lstat(expectedPackageRoot);
      if (expectedStat.isSymbolicLink()) {
        const [realExpectedRoot, realCurrentRoot] = await Promise.all([
          fileSystem.realpath(expectedPackageRoot),
          fileSystem.realpath(resolvedPackageRoot),
        ]);
        if (
          comparablePath(realExpectedRoot, platform) === comparablePath(realCurrentRoot, platform)
        ) {
          return unsupported(
            "linked",
            "npm link, symlink, and junction installations are unsupported.",
          );
        }
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        return unsupported(
          "filesystem-error",
          `Could not inspect the npm global package path: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return unsupported(
      "not-global",
      "MiniCPA is not the direct package at the path reported by npm root -g.",
    );
  }

  try {
    const packageStat = await fileSystem.lstat(expectedPackageRoot);
    if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
      return unsupported(
        "linked",
        "npm link, symlink, and junction installations are unsupported.",
      );
    }
    // lstat above rejects a link/junction at the package entry itself. Do not compare
    // this path with realpath: otherwise normal ancestor aliases are misclassified as
    // npm link installs (`/var` -> `/private/var` on macOS, or Windows 8.3 names).
    if (
      !(await globalBinTargetsPackage(layout.prefix, expectedPackageRoot, platform, fileSystem))
    ) {
      return unsupported(
        "not-global",
        `The npm global cpa shim is missing or does not target ${expectedPackageRoot}.`,
      );
    }

    const markerPaths = [
      api.join(layout.prefix, "package.json"),
      api.join(layout.prefix, "pnpm-lock.yaml"),
      api.join(layout.prefix, "yarn.lock"),
      api.join(layout.prefix, "bun.lock"),
      api.join(layout.prefix, "bun.lockb"),
      api.join(layout.globalRoot, ".pnpm"),
      api.join(expectedPackageRoot, ".git"),
    ];
    for (const markerPath of markerPaths) {
      if (await pathExists(markerPath, fileSystem)) {
        const markerName = api.basename(markerPath);
        const reason =
          markerName === "package.json"
            ? "project-prefix"
            : markerName === ".git"
              ? "source-install"
              : "other-package-manager";
        return unsupported(
          reason,
          `Refusing an ambiguous project or non-npm global prefix (${markerPath}).`,
        );
      }
    }

    if (options.requireWritable !== false) {
      await fileSystem.access(layout.prefix, constants.W_OK);
      await fileSystem.access(layout.globalRoot, constants.W_OK);
      await fileSystem.access(expectedPackageRoot, constants.W_OK);
    }
  } catch (error) {
    if (
      errorCode(error) === "EACCES" ||
      errorCode(error) === "EPERM" ||
      errorCode(error) === "EROFS"
    ) {
      return unsupported(
        "not-writable",
        `The npm global installation is not writable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return unsupported(
      "filesystem-error",
      `Could not verify the npm global installation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    supported: true,
    prefix: layout.prefix,
    globalRoot: layout.globalRoot,
    expectedPackageRoot,
    npmCommand,
  };
}
