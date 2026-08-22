#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";

const packageName = "@astralyn/minicpa";
const [installSpec, expectedVersionArgument] = process.argv.slice(2);

if (!installSpec) {
  console.error(
    "Usage: npm run verify:package-install -- <tarball-or-package-spec> [expected-version]",
  );
  process.exit(1);
}

const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
  console.error(
    "Package install verification must be run through npm so npm_execpath is available.\n" +
      "Run: npm run verify:package-install -- <tarball-or-package-spec> [expected-version]",
  );
  process.exit(1);
}

const sourcePackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedVersion = expectedVersionArgument ?? sourcePackage.version;
if (
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    expectedVersion,
  )
) {
  console.error(`Expected an exact package version, got ${JSON.stringify(expectedVersion)}.`);
  process.exit(1);
}
const localCandidate = resolve(process.cwd(), installSpec);
const looksLikeLocalArtifact =
  isAbsolute(installSpec) ||
  installSpec.startsWith(".") ||
  (!/^https?:\/\//i.test(installSpec) && installSpec.toLowerCase().endsWith(".tgz"));
if (looksLikeLocalArtifact && !existsSync(localCandidate)) {
  console.error(`Local package tarball does not exist: ${localCandidate}`);
  process.exit(1);
}
const resolvedInstallSpec = existsSync(localCandidate) ? localCandidate : installSpec;
const installDirectory = mkdtempSync(join(tmpdir(), "minicpa-package-smoke-"));
const packageDirectory = join(installDirectory, "node_modules", "@astralyn", "minicpa");

function assertEqual(actual, expected, description) {
  if (actual !== expected) {
    throw new Error(
      `${description}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`,
    );
  }
}

function assertFile(relativePath) {
  const filePath = join(packageDirectory, ...relativePath.split("/"));
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(
      `Installed package is missing required file ${relativePath}. Check package.json files and the build output.`,
    );
  }
}

function createSmokeEnvironment() {
  const environment = { ...process.env };
  const namedCredentialKeys = new Set([
    "npm_token",
    "npm_auth_token",
    "node_auth_token",
    "gh_token",
    "gh_enterprise_token",
    "gh_pat",
    "github_token",
    "github_enterprise_token",
    "github_pat",
    "github_access_token",
    "npm_id_token",
    "actions_id_token_request_token",
    "actions_id_token_request_url",
  ]);
  for (const key of Object.keys(environment)) {
    const normalized = key.toLowerCase();
    const isNpmAuthConfig =
      normalized.startsWith("npm_config_") &&
      (normalized.includes("authtoken") ||
        normalized.includes("auth_token") ||
        normalized.endsWith("_auth"));
    if (
      namedCredentialKeys.has(normalized) ||
      isNpmAuthConfig ||
      normalized === "npm_config_userconfig" ||
      normalized === "npm_config_globalconfig" ||
      normalized === "npm_config_registry" ||
      normalized === "npm_config_strict_ssl" ||
      normalized === "npm_config_ignore_scripts" ||
      normalized === "npm_config_audit" ||
      normalized === "npm_config_fund" ||
      normalized === "npm_config_update_notifier" ||
      normalized === "npm_config_min_release_age" ||
      normalized === "node_options" ||
      normalized === "node_tls_reject_unauthorized"
    ) {
      delete environment[key];
    }
  }

  return {
    ...environment,
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_ignore_scripts: "true",
    npm_config_registry: "https://registry.npmjs.org",
    npm_config_strict_ssl: "true",
    npm_config_update_notifier: "false",
    npm_config_userconfig: join(installDirectory, ".npmrc"),
    npm_config_globalconfig: join(installDirectory, ".npmrc-global"),
    ...(process.env.MINICPA_PACKAGE_ALLOW_FRESH === "1" ? { npm_config_min_release_age: "0" } : {}),
  };
}

function runCli(binPath, args, environment) {
  try {
    if (process.platform === "win32") {
      const command = `""${binPath}" ${args.join(" ")}"`;
      return execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
        cwd: installDirectory,
        encoding: "utf8",
        env: environment,
        windowsVerbatimArguments: true,
      });
    }
    return execFileSync(binPath, args, {
      cwd: installDirectory,
      encoding: "utf8",
      env: environment,
    });
  } catch (error) {
    throw new Error(`Installed cpa shim failed for ${args.join(" ")}.`, { cause: error });
  }
}

try {
  writeFileSync(
    join(installDirectory, "package.json"),
    `${JSON.stringify(
      { name: "minicpa-package-smoke", version: "1.0.0", private: true },
      null,
      2,
    )}\n`,
  );
  // Empty user/global configs prevent credentials from the caller's npmrc files reaching npm.
  writeFileSync(join(installDirectory, ".npmrc"), "");
  writeFileSync(join(installDirectory, ".npmrc-global"), "");
  const smokeEnvironment = createSmokeEnvironment();

  try {
    execFileSync(
      process.execPath,
      [
        npmCliPath,
        "--prefix",
        installDirectory,
        "install",
        "--ignore-scripts",
        "--save-exact",
        resolvedInstallSpec,
      ],
      {
        cwd: installDirectory,
        env: smokeEnvironment,
        stdio: "inherit",
      },
    );
  } catch (error) {
    throw new Error(
      `npm could not install ${JSON.stringify(resolvedInstallSpec)} in the clean temporary project.`,
      { cause: error },
    );
  }

  const manifestPath = join(packageDirectory, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`npm install completed, but ${packageName} was not found in node_modules.`);
  }
  const installedPackage = JSON.parse(readFileSync(manifestPath, "utf8"));
  assertEqual(installedPackage.name, packageName, "installed package name");
  assertEqual(installedPackage.version, expectedVersion, "installed package version");
  assertEqual(installedPackage.bin?.cpa, "dist/cli.js", "installed cpa binary target");
  assertEqual(installedPackage.engines?.node, ">=24", "installed Node.js engine requirement");

  for (const relativePath of [
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "dist/cli.js",
    "dist/commands/upgrade-cmd.js",
    "dist/update/minicpa-release.js",
    "dist/update/self-upgrade.js",
    "docs/cpa-reference.md",
  ]) {
    assertFile(relativePath);
  }

  const forbiddenExactPaths = ["src", ".github", "scripts", "RELEASING.md", ".npmrc"];
  for (const relativePath of forbiddenExactPaths) {
    if (existsSync(join(packageDirectory, ...relativePath.split("/")))) {
      throw new Error(
        `Installed package unexpectedly contains forbidden path ${relativePath}. Tighten package.json files.`,
      );
    }
  }
  for (const entry of readdirSync(packageDirectory)) {
    const lowerEntry = entry.toLowerCase();
    if (
      lowerEntry === ".env" ||
      lowerEntry.startsWith(".env.") ||
      lowerEntry.startsWith("package-lock") ||
      lowerEntry.startsWith("agents") ||
      lowerEntry.startsWith("tsconfig")
    ) {
      throw new Error(
        `Installed package unexpectedly contains forbidden path ${entry}. Tighten package.json files.`,
      );
    }
  }

  const posixBinPath = join(installDirectory, "node_modules", ".bin", "cpa");
  if (!existsSync(posixBinPath) || !statSync(posixBinPath).isFile()) {
    throw new Error("npm did not create the cpa shim in node_modules/.bin.");
  }
  if (process.platform !== "win32" && (statSync(posixBinPath).mode & 0o111) === 0) {
    throw new Error("npm created node_modules/.bin/cpa without a POSIX executable mode.");
  }

  const executableBinPath = process.platform === "win32" ? `${posixBinPath}.cmd` : posixBinPath;
  if (!existsSync(executableBinPath)) {
    throw new Error(`npm did not create the platform cpa shim at ${executableBinPath}.`);
  }

  const cliVersion = runCli(executableBinPath, ["--version"], smokeEnvironment).trim();
  assertEqual(cliVersion, expectedVersion, "cpa --version output");

  const rootHelp = runCli(executableBinPath, ["--help"], smokeEnvironment);
  if (!/^\s*update(?:\s|$)/m.test(rootHelp) || !/^\s*upgrade(?:\s|$)/m.test(rootHelp)) {
    throw new Error("cpa --help must list both the update and upgrade commands.");
  }

  const upgradeHelp = runCli(executableBinPath, ["upgrade", "--help"], smokeEnvironment);
  if (!/Usage:\s+cpa upgrade\b/.test(upgradeHelp)) {
    throw new Error("cpa upgrade --help did not show help for the upgrade command.");
  }

  console.log(
    `Verified clean installation of ${packageName}@${expectedVersion} from ${resolvedInstallSpec}.`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Package install verification failed: ${message}`);
  process.exitCode = 1;
} finally {
  rmSync(installDirectory, { force: true, recursive: true });
}
