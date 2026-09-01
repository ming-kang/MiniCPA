#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
  throw new Error("Package verification must run through npm so npm_execpath is available.");
}

const repositoryDirectory = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageFileStem = packageJson.name.replace(/^@/, "").replaceAll("/", "-");
const artifactDirectory = mkdtempSync(join(tmpdir(), "minicpa-pack-verify-"));
const tarball = join(artifactDirectory, `${packageFileStem}-${packageJson.version}.tgz`);

try {
  execFileSync(
    process.execPath,
    [npmCliPath, "pack", "--ignore-scripts", "--silent", "--pack-destination", artifactDirectory],
    { cwd: repositoryDirectory, stdio: "inherit" },
  );
  if (!existsSync(tarball)) {
    throw new Error(`npm pack did not create the expected artifact: ${tarball}`);
  }

  execFileSync(
    process.execPath,
    [npmCliPath, "run", "verify:package-install", "--", tarball, packageJson.version],
    { cwd: repositoryDirectory, stdio: "inherit" },
  );
} finally {
  rmSync(artifactDirectory, { recursive: true, force: true });
}
