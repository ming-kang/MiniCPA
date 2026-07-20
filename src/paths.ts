import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";

/** Single branded namespace — avoids generic "CPA" colliding with other installs. */
export const MINICPA_DIR_NAME = "MiniCPA";

export type CliGlobalConfig = {
  /** Managed CLIProxyAPI instance directory (config, auths, binary). */
  home?: string;
};

/**
 * MiniCPA application root (CLI config, default instance).
 * Windows: %LOCALAPPDATA%\MiniCPA
 */
function envPathOr(fallback: string, value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function miniCpaRoot(): string {
  if (process.platform === "win32") {
    const base = envPathOr(
      path.join(os.homedir(), "AppData", "Local"),
      process.env.LOCALAPPDATA,
    );
    return path.join(base, MINICPA_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", MINICPA_DIR_NAME);
  }
  const xdgData = envPathOr(
    path.join(os.homedir(), ".local", "share"),
    process.env.XDG_DATA_HOME,
  );
  return path.join(xdgData, MINICPA_DIR_NAME);
}

/** Default (only) CPA instance directory. */
export function defaultCpaHome(): string {
  return path.join(miniCpaRoot(), "instances", "default");
}

/** @deprecated v0.1 layout; used only if it exists and default does not. */
export function legacyCpaHome(): string {
  return path.join(miniCpaRoot(), "instance");
}

/**
 * Ephemeral MiniCPA files (release zips, extract staging). OS temp — safe to wipe.
 * Windows: %TEMP%\MiniCPA
 */
export function miniCpaTempRoot(): string {
  return path.join(os.tmpdir(), MINICPA_DIR_NAME);
}

export function miniCpaTempDownloadsDir(): string {
  return path.join(miniCpaTempRoot(), "downloads");
}

/** Unique per-operation download directory; safe for updates across multiple homes. */
export function miniCpaTempDownloadDir(prefix = "download-"): string {
  const downloads = miniCpaTempDownloadsDir();
  ensureDir(downloads);
  return fs.mkdtempSync(path.join(downloads, prefix));
}

export function miniCpaTempExtractDir(prefix = "extract-"): string {
  ensureDir(miniCpaTempRoot());
  return fs.mkdtempSync(path.join(miniCpaTempRoot(), prefix));
}

export function cliConfigPath(): string {
  return path.join(miniCpaRoot(), "config.json");
}

export function readCliGlobalConfig(): CliGlobalConfig {
  const file = cliConfigPath();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as CliGlobalConfig;
  } catch {
    return {};
  }
}

export function writeCliGlobalConfig(config: CliGlobalConfig): void {
  const dir = miniCpaRoot();
  fs.mkdirSync(dir, { recursive: true });
  const merged: CliGlobalConfig = { ...readCliGlobalConfig(), ...config };
  writeFileAtomic(cliConfigPath(), JSON.stringify(merged, null, 2) + "\n");
}

export function resolveCpaHome(explicit?: string): string {
  if (explicit?.trim()) return path.resolve(explicit.trim());
  const envHome = process.env.CPA_HOME?.trim();
  if (envHome) return path.resolve(envHome);
  const global = readCliGlobalConfig().home;
  if (global?.trim()) return path.resolve(global.trim());
  const current = defaultCpaHome();
  const legacy = legacyCpaHome();
  if (
    fs.existsSync(path.join(legacy, "config.yaml")) &&
    !fs.existsSync(path.join(current, "config.yaml"))
  ) {
    return legacy;
  }
  return current;
}

export type CpaLayout = {
  home: string;
  configFile: string;
  envFile: string;
  authsDir: string;
  staticDir: string;
  logsDir: string;
  stateDir: string;
  pidFile: string;
  installStateFile: string;
  logFile: string;
  errLogFile: string;
  managementHtml: string;
};

export function cpaLayout(home: string): CpaLayout {
  return {
    home,
    configFile: path.join(home, "config.yaml"),
    envFile: path.join(home, ".env"),
    authsDir: path.join(home, "auths"),
    staticDir: path.join(home, "static"),
    logsDir: path.join(home, "logs"),
    stateDir: path.join(home, "state"),
    pidFile: path.join(home, "state", "cpa.pid"),
    installStateFile: path.join(home, "state", "install.json"),
    logFile: path.join(home, "logs", "cpa.log"),
    errLogFile: path.join(home, "logs", "cpa.err.log"),
    managementHtml: path.join(home, "static", "management.html"),
  };
}

export function executableName(): string {
  return process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
}

/** Single active binary under the instance root (replaced on each update). */
export function activeExecutablePath(home: string): string {
  return path.join(home, executableName());
}

/** Previous binary kept during update for rollback. */
export function backupExecutablePath(home: string): string {
  return `${activeExecutablePath(home)}.bak`;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
