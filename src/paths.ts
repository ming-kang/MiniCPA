import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "./fs-atomic.js";

/** Single branded namespace — avoids generic "CPA" colliding with other installs. */
export const MINICPA_DIR_NAME = "MiniCPA";

export type CliGlobalConfig = {
  /** Legacy pointer to the one managed instance home (read for migration only). */
  home?: string;
};

/**
 * MiniCPA application root (CLI config, default instance).
 * Windows: %LOCALAPPDATA%\MiniCPA
 */
function envPathOr(fallback: string, value: string | undefined): string {
  const trimmed = value?.trim();
  // Per the XDG Base Directory spec, a non-absolute value must be ignored: a
  // cwd-relative root would move the global lock with the working directory.
  return trimmed && path.isAbsolute(trimmed) ? trimmed : fallback;
}

export function miniCpaRoot(): string {
  if (process.platform === "win32") {
    const base = envPathOr(path.join(os.homedir(), "AppData", "Local"), process.env.LOCALAPPDATA);
    return path.join(base, MINICPA_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", MINICPA_DIR_NAME);
  }
  const xdgData = envPathOr(path.join(os.homedir(), ".local", "share"), process.env.XDG_DATA_HOME);
  return path.join(xdgData, MINICPA_DIR_NAME);
}

/** The one managed CPA instance directory. */
export function defaultCpaHome(): string {
  return path.join(miniCpaRoot(), "instances", "default");
}

/** @deprecated v0.1 layout; used only if it exists and default does not. */
export function legacyCpaHome(): string {
  return path.join(miniCpaRoot(), "instance");
}

/** Ephemeral MiniCPA files (release zips, extract staging) under private app data. */
export function miniCpaTempRoot(): string {
  // Keep staging under MiniCPA's private application root rather than a predictable
  // shared OS-temp path such as /tmp/MiniCPA, which is vulnerable to symlink attacks.
  return path.join(miniCpaRoot(), "temp");
}

export function miniCpaTempDownloadsDir(): string {
  return path.join(miniCpaTempRoot(), "downloads");
}

/** Unique per-operation download directory. */
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  // A structurally corrupt config.json must not crash every command, so keep
  // only the fields that match the declared shape.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const home = (parsed as Record<string, unknown>).home;
  return typeof home === "string" ? { home } : {};
}

export function writeCliGlobalConfig(config: CliGlobalConfig): void {
  const dir = miniCpaRoot();
  ensureDir(dir);
  const merged: CliGlobalConfig = { ...readCliGlobalConfig(), ...config };
  writeFileAtomic(cliConfigPath(), `${JSON.stringify(merged, null, 2)}\n`);
}

export function resolveCpaHome(): string {
  if (process.env.CPA_HOME?.trim()) {
    throw new Error(
      "CPA_HOME is no longer supported: MiniCPA manages one instance only. Unset it and migrate the existing home before continuing.",
    );
  }
  // Honor the previous persisted selection so upgrades retain the one existing install.
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

/** Tighten permissions for an existing installation without following symlinks. */
export function hardenCpaPermissions(home: string): void {
  if (process.platform === "win32" || !fs.existsSync(home)) return;

  const chmodPrivate = (target: string, recursive: boolean): void => {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    try {
      fs.chmodSync(target, stat.isDirectory() ? 0o700 : 0o600);
    } catch {
      return;
    }
    if (!recursive || !stat.isDirectory()) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      chmodPrivate(path.join(target, entry.name), true);
    }
  };

  const layout = cpaLayout(home);
  chmodPrivate(home, false);
  chmodPrivate(layout.configFile, false);
  chmodPrivate(layout.envFile, false);
  for (const directory of [layout.authsDir, layout.logsDir, layout.stateDir, layout.staticDir]) {
    chmodPrivate(directory, true);
  }
  try {
    for (const entry of fs.readdirSync(home)) {
      if (entry.startsWith("config.yaml.bak.")) {
        chmodPrivate(path.join(home, entry), false);
      }
    }
  } catch {
    /* best-effort upgrade hardening */
  }
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

/** Transient name the active binary takes during the Windows unlock probe. */
export function unlockProbePath(home: string): string {
  return `${activeExecutablePath(home)}.unlock-probe`;
}

/** Create a MiniCPA-private directory (0700 on POSIX). */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(dir, 0o700);
  }
}
