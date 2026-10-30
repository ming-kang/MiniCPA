#!/usr/bin/env node

// Release helpers shared by maintainers and .github/workflows/publish.yml:
//   prepare <version>  bump package.json/package-lock.json and date the Unreleased notes
//   verify <version>   check that the package files and CHANGELOG.md describe <version>
//   notes <version>    print the GitHub Release body for <version>

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const changelogUrl = new URL("CHANGELOG.md", root);
const UNRELEASED = "## [Unreleased]\n";

function readJson(name) {
  return JSON.parse(readFileSync(new URL(name, root), "utf8"));
}

function readChangelog() {
  return readFileSync(changelogUrl, "utf8").replace(/\r\n/g, "\n");
}

function assertStableVersion(version) {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected a stable x.y.z version, got ${version ?? "nothing"}.`);
  }
}

function isNewer(version, current) {
  const a = version.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

/** The notes between `## [version] - date` and the next release heading. */
function releaseSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`## [${version}] - `));
  if (start === -1) throw new Error(`CHANGELOG.md has no release heading for ${version}.`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
  const body = lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join("\n")
    .trim();
  if (!body) throw new Error(`CHANGELOG.md has no notes under ${version}.`);
  return body;
}

function verify(version) {
  assertStableVersion(version);
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  if (
    packageJson.version !== version ||
    packageLock.version !== version ||
    packageLock.packages?.[""]?.version !== version
  ) {
    throw new Error(`package.json and package-lock.json must both be at ${version}.`);
  }
  releaseSection(readChangelog(), version);
}

function prepare(version) {
  assertStableVersion(version);
  const current = readJson("package.json").version;
  if (!isNewer(version, current)) {
    throw new Error(`${version} is not newer than the current version ${current}.`);
  }
  const changelog = readChangelog();
  const at = changelog.indexOf(UNRELEASED);
  if (at === -1) throw new Error("CHANGELOG.md has no ## [Unreleased] section.");
  const after = at + UNRELEASED.length;
  const next = changelog.indexOf("\n## [", after);
  if (!changelog.slice(after, next === -1 ? undefined : next).trim()) {
    throw new Error("## [Unreleased] is empty; describe the release in CHANGELOG.md first.");
  }

  const npmCliPath = process.env.npm_execpath;
  if (!npmCliPath) throw new Error("Run through npm: npm run release:prepare -- x.y.z");
  execFileSync(process.execPath, [npmCliPath, "version", version, "--no-git-tag-version"], {
    cwd: root,
    stdio: "ignore",
  });

  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  writeFileSync(
    changelogUrl,
    `${changelog.slice(0, after)}\n## [${version}] - ${date}\n${changelog.slice(after)}`,
  );
  verify(version);
  console.log(`Prepared ${version}: package.json, package-lock.json and CHANGELOG.md.`);
  console.log(`Review the notes, then commit "chore(release): ${version}" and push to main.`);
}

function notes(version) {
  assertStableVersion(version);
  const packageJson = readJson("package.json");
  const repository = packageJson.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");
  const node = packageJson.engines.node.replace(/^>=\s*(\d+)$/, "$1+");
  return [
    releaseSection(readChangelog(), version),
    "",
    "## Install or upgrade",
    "",
    "```sh",
    `npm install -g ${packageJson.name}@${version}`,
    "```",
    "",
    `Existing global installs can run \`cpa upgrade\`. Requires Node.js ${node}. ` +
      `Earlier releases are in [CHANGELOG.md](${repository}/blob/v${version}/CHANGELOG.md).`,
    "",
  ].join("\n");
}

const [command, version] = process.argv.slice(2);
try {
  if (command === "prepare") prepare(version);
  else if (command === "verify") verify(version);
  else if (command === "notes") process.stdout.write(notes(version));
  else throw new Error("Usage: node scripts/release.mjs <prepare|verify|notes> <x.y.z>");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
