import type { SpawnOptions } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import spawn from "cross-spawn";
import { valid } from "semver";
import { buildCredentialSafeChildEnv } from "../process/child-env.js";
import { isExactSemver } from "../util.js";
import { MINICPA_PACKAGE_NAME, NPM_REGISTRY_BASE_URL } from "./minicpa-release.js";
import type { SupportedNpmGlobalInstall } from "./npm-global-detection.js";

// Re-export detection types and functions for backward compatibility with existing callers.
export {
  classifyNpmGlobalRoot,
  detectNpmGlobalInstall,
  inferNpmGlobalRoot,
  type CapturedCommand,
  type CaptureCommand,
  type GlobalRootLayout,
  type NpmGlobalInstallDetection,
  type NpmGlobalInstallDetectionOptions,
  type SelfUpgradeDetectionDependencies,
  type SupportedNpmGlobalInstall,
  type UnsupportedNpmGlobalInstall,
} from "./npm-global-detection.js";

interface SpawnedCommand {
  stdout: Readable | null;
  stderr: Readable | null;
  once(event: "error", listener: (error: Error & { code?: string }) => void): this;
  once(
    event: "close",
    listener: (status: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export type SpawnCommand = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => SpawnedCommand;

export type SelfUpgradeInstallDependencies = {
  spawn: SpawnCommand;
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  env: NodeJS.ProcessEnv;
};

function assertCanonicalExactVersion(version: string): void {
  if (!isExactSemver(version) || valid(version) === null) {
    throw new Error(
      `Refusing non-canonical MiniCPA version "${version}". Expected an exact version such as 1.2.3.`,
    );
  }
}

type UpgradeOperation = "install" | "update";

function buildNpmUpgradeArgs(
  prefix: string,
  operation: UpgradeOperation,
  version: string,
): string[] {
  return [
    "--prefix",
    prefix,
    operation,
    "--global",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `--registry=${NPM_REGISTRY_BASE_URL}`,
    operation === "install" ? `${MINICPA_PACKAGE_NAME}@${version}` : MINICPA_PACKAGE_NAME,
  ];
}

function manualRetryCommand(
  detection: SupportedNpmGlobalInstall,
  operation: UpgradeOperation,
  version: string,
): string {
  const args = buildNpmUpgradeArgs(JSON.stringify(detection.prefix), operation, version);
  return [detection.npmCommand, ...args].join(" ");
}

function upgradeFailure(
  detection: SupportedNpmGlobalInstall,
  operation: UpgradeOperation,
  version: string,
  detail: string,
  cause?: unknown,
  retryCommand = manualRetryCommand(detection, operation, version),
): Error {
  return new Error(
    `MiniCPA upgrade failed: ${detail}\nRetry manually with:\n${retryCommand}`,
    cause === undefined ? undefined : { cause },
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function npmArguments(
  detection: SupportedNpmGlobalInstall,
  operation: UpgradeOperation,
  version: string,
): string[] {
  return buildNpmUpgradeArgs(detection.prefix, operation, version);
}

async function runNpmUpgrade(
  detection: SupportedNpmGlobalInstall,
  version: string,
  operation: UpgradeOperation,
  dependencies: Partial<SelfUpgradeInstallDependencies>,
): Promise<void> {
  assertCanonicalExactVersion(version);
  const spawnCommand = dependencies.spawn ?? (spawn as SpawnCommand);
  const readFile =
    dependencies.readFile ?? ((filePath, encoding) => fs.readFile(filePath, encoding));
  const env = dependencies.env ?? process.env;

  let result: { status: number | null; signal: NodeJS.Signals | null };
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawnCommand(
        detection.npmCommand,
        npmArguments(detection, operation, version),
        {
          shell: false,
          stdio: "inherit",
          windowsHide: true,
          env: buildCredentialSafeChildEnv(env),
        },
      );
      child.once("error", reject);
      child.once("close", (status, signal) => resolve({ status, signal }));
    });
  } catch (error) {
    const detail =
      errorCode(error) === "ENOENT"
        ? `${detection.npmCommand} was not found. Reinstall npm or restore MiniCPA with the command below.`
        : `could not start npm (${error instanceof Error ? error.message : String(error)}).`;
    throw upgradeFailure(detection, operation, version, detail, error);
  }

  if (result.signal !== null) {
    throw upgradeFailure(
      detection,
      operation,
      version,
      `npm was terminated by signal ${result.signal}.`,
    );
  }
  if (result.status !== 0) {
    throw upgradeFailure(
      detection,
      operation,
      version,
      `npm exited with status ${String(result.status)}.`,
    );
  }

  let installedManifest: { name?: unknown; version?: unknown };
  try {
    const installPathApi = detection.npmCommand === "npm.cmd" ? path.win32 : path.posix;
    const raw = await readFile(
      installPathApi.join(detection.expectedPackageRoot, "package.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    installedManifest =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as { name?: unknown; version?: unknown })
        : {};
  } catch (error) {
    throw upgradeFailure(
      detection,
      operation,
      version,
      "npm exited successfully, but the installed package.json could not be read or parsed.",
      error,
      manualRetryCommand(detection, "install", "latest"),
    );
  }
  if (installedManifest.name !== MINICPA_PACKAGE_NAME || installedManifest.version !== version) {
    throw upgradeFailure(
      detection,
      operation,
      version,
      `post-upgrade verification expected ${MINICPA_PACKAGE_NAME}@${version}, received ${String(installedManifest.name)}@${String(installedManifest.version)}.`,
      undefined,
      manualRetryCommand(detection, "install", "latest"),
    );
  }
}

/** Install an already validated exact release into a proven direct npm global installation. */
export async function installMinicpaVersion(
  detection: SupportedNpmGlobalInstall,
  version: string,
  dependencies: Partial<SelfUpgradeInstallDependencies> = {},
): Promise<void> {
  await runNpmUpgrade(detection, version, "install", dependencies);
}

/** Update a proven direct npm global installation and verify the fetched release was installed. */
export async function updateMinicpaVersion(
  detection: SupportedNpmGlobalInstall,
  version: string,
  dependencies: Partial<SelfUpgradeInstallDependencies> = {},
): Promise<void> {
  await runNpmUpgrade(detection, version, "update", dependencies);
}
