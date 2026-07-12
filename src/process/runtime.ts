import fs from "node:fs";
import {
  activeExecutablePath,
  cpaLayout,
  currentVersionPointerPath,
  ensureDir,
  executableName,
  runtimeVersionDir,
  runtimeVersionExecutable,
} from "../paths.js";
import { readInstalledRuntimeVersion } from "../util.js";

export async function readCurrentRuntimeVersion(home: string): Promise<string | undefined> {
  const pointer = currentVersionPointerPath(home);
  if (fs.existsSync(pointer)) {
    const v = fs.readFileSync(pointer, "utf8").trim();
    if (v) return v;
  }
  const exe = activeExecutablePath(home);
  return readInstalledRuntimeVersion(exe);
}

export function installRuntimeBinary(home: string, version: string, sourceExe: string): void {
  const targetDir = runtimeVersionDir(home, version);
  ensureDir(targetDir);
  const targetExe = runtimeVersionExecutable(home, version);
  fs.copyFileSync(sourceExe, targetExe);
  setCurrentRuntime(home, version);
  publishActiveExecutable(home, version);
}

export function setCurrentRuntime(home: string, version: string): void {
  ensureDir(runtimeVersionDir(home, version));
  fs.writeFileSync(currentVersionPointerPath(home), `${version}\n`, "utf8");
}

export function publishActiveExecutable(home: string, version: string): void {
  const source = runtimeVersionExecutable(home, version);
  const target = activeExecutablePath(home);
  if (!fs.existsSync(source)) {
    throw new Error(`Runtime binary missing: ${source}`);
  }
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.linkSync(source, target);
  } catch {
    fs.copyFileSync(source, target);
  }
  if (process.platform !== "win32") {
    fs.chmodSync(target, 0o755);
  }
}

export function resolveRunnableExecutable(home: string): string {
  const layout = cpaLayout(home);
  const active = activeExecutablePath(home);
  if (fs.existsSync(active)) return active;

  const pointer = currentVersionPointerPath(home);
  if (fs.existsSync(pointer)) {
    const version = fs.readFileSync(pointer, "utf8").trim();
    const versioned = runtimeVersionExecutable(home, version);
    if (fs.existsSync(versioned)) return versioned;
  }

  const runtimeRoot = layout.runtimeDir;
  if (fs.existsSync(runtimeRoot)) {
    const versions = fs
      .readdirSync(runtimeRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "current")
      .map((d) => d.name)
      .sort();
    const last = versions.at(-1);
    if (last) {
      const versioned = runtimeVersionExecutable(home, last);
      if (fs.existsSync(versioned)) return versioned;
    }
  }

  throw new Error(
    `CPA binary not found under ${home}. Run: cpa update`,
  );
}

export function executableBasename(): string {
  return executableName();
}