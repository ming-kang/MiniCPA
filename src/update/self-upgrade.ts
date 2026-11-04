import type { SpawnOptions } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import spawn from "cross-spawn";
import { valid } from "semver";
import { buildCredentialSafeChildEnv } from "../process/child-env.js";
import { isExactSemver } from "../util.js";
import { MINICPA_PACKAGE_NAME, NPM_REGISTRY_BASE_URL } from "./minicpa-release.js";
import type { SupportedNpmGlobalInstall } from "./npm-global-detection.js";

interface SpawnedCommand {
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

// Always an exact `install`: `npm update -g` resolves its own "wanted" version, which
// can differ from the one fetched (0.x ranges, or a publish in between) and then fails
// the exact post-install verification.
function buildNpmInstallArgs(prefix: string, version: string): string[] {
  return [
    "--prefix",
    prefix,
    "install",
    "--global",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    `--registry=${NPM_REGISTRY_BASE_URL}`,
    `${MINICPA_PACKAGE_NAME}@${version}`,
  ];
}

function manualRetryCommand(detection: SupportedNpmGlobalInstall, version: string): string {
  const args = buildNpmInstallArgs(JSON.stringify(detection.prefix), version);
  return [detection.npmCommand, ...args].join(" ");
}

function upgradeFailure(
  detection: SupportedNpmGlobalInstall,
  retryVersion: string,
  detail: string,
  cause?: unknown,
): Error {
  return new Error(
    `MiniCPA upgrade failed: ${detail}
Retry manually with:
${manualRetryCommand(detection, retryVersion)}`,
    cause === undefined ? undefined : { cause },
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export async function executeMinicpaUpgrade(
  detection: SupportedNpmGlobalInstall,
  version: string,
  dependencies: Partial<SelfUpgradeInstallDependencies> = {},
): Promise<void> {
  assertCanonicalExactVersion(version);
  const spawnCommand = dependencies.spawn ?? (spawn as SpawnCommand);
  const readFile = dependencies.readFile ?? fs.readFile;
  const env = dependencies.env ?? process.env;

  let result: { status: number | null; signal: NodeJS.Signals | null };
  try {
    result = await new Promise((resolve, reject) => {
      const child = spawnCommand(
        detection.npmCommand,
        buildNpmInstallArgs(detection.prefix, version),
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
    throw upgradeFailure(detection, version, detail, error);
  }

  if (result.signal !== null) {
    throw upgradeFailure(detection, version, `npm was terminated by signal ${result.signal}.`);
  }
  if (result.status !== 0) {
    throw upgradeFailure(detection, version, `npm exited with status ${String(result.status)}.`);
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
      "latest",
      "npm exited successfully, but the installed package.json could not be read or parsed.",
      error,
    );
  }
  if (installedManifest.name !== MINICPA_PACKAGE_NAME || installedManifest.version !== version) {
    throw upgradeFailure(
      detection,
      "latest",
      `post-upgrade verification expected ${MINICPA_PACKAGE_NAME}@${version}, received ${String(installedManifest.name)}@${String(installedManifest.version)}.`,
    );
  }
}
