import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Single branded namespace — avoids generic "CPA" colliding with other installs. */
export const MINICPA_DIR_NAME = "MiniCPA";

export type CliGlobalConfig = {
  /** Managed CLIProxyAPI instance directory (config, auths, runtime). */
  home?: string;
};

/**
 * MiniCPA application root (CLI config, cache, default instance).
 * Windows: %LOCALAPPDATA%\MiniCPA
 */
export function miniCpaRoot(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, MINICPA_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", MINICPA_DIR_NAME);
  }
  const xdgData = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdgData, MINICPA_DIR_NAME);
}

/**
 * Default CPA instance directory.
 * Multiple instances can live under `instances/<name>/` (see README).
 */
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

export function miniCpaTempExtractDir(prefix = "extract-"): string {
  ensureDir(miniCpaTempRoot());
  return fs.mkdtempSync(path.join(miniCpaTempRoot(), prefix));
}

export function cliConfigPath(): string {
  return path.join(miniCpaRoot(), "config.json");
}

/** Optional long-lived cache (e.g. `cpa cache clean`); updates prefer temp downloads. */
export function cliCacheDir(): string {
  return path.join(miniCpaRoot(), "cache");
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
  fs.writeFileSync(cliConfigPath(), JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function resolveCpaHome(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.CPA_HOME) return path.resolve(process.env.CPA_HOME);
  const global = readCliGlobalConfig().home;
  if (global) return path.resolve(global);
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
  runtimeDir: string;
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
    runtimeDir: path.join(home, "runtime"),
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

export function activeExecutablePath(home: string): string {
  return path.join(home, executableName());
}

export function runtimeVersionDir(home: string, version: string): string {
  return path.join(home, "runtime", version);
}

export function runtimeVersionExecutable(home: string, version: string): string {
  return path.join(runtimeVersionDir(home, version), executableName());
}

export function currentVersionPointerPath(home: string): string {
  return path.join(home, "runtime", "current");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}