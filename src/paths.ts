import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MINICPA_DIR_NAME = "MiniCPA";

function envPathOr(fallback: string, value: string | undefined): string {
  const trimmed = value?.trim();
  // Per XDG spec, ignore non-absolute paths so relative roots don't shift with cwd.
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

export function cpaHome(): string {
  return path.join(miniCpaRoot(), "instance");
}

export function miniCpaTempRoot(): string {
  // Keep staging under private app root to prevent shared /tmp symlink attacks.
  return path.join(miniCpaRoot(), "temp");
}

export function miniCpaTempOperationDir(): string {
  const operations = path.join(miniCpaTempRoot(), "operations");
  ensureDir(operations);
  return fs.mkdtempSync(path.join(operations, "update-"));
}

export function resolveCpaHome(): string {
  if (process.env.CPA_HOME?.trim()) {
    throw new Error(
      "CPA_HOME is not supported: MiniCPA manages one canonical instance only. Unset it before continuing.",
    );
  }
  return cpaHome();
}

export type CpaLayout = {
  home: string;
  configFile: string;
  authsDir: string;
  staticDir: string;
  logsDir: string;
  stateDir: string;
  pidFile: string;
  installStateFile: string;
  runtimeLogFile: string;
  minicpaLogFile: string;
};

export function cpaLayout(home: string): CpaLayout {
  return {
    home,
    configFile: path.join(home, "config.yaml"),
    authsDir: path.join(home, "auths"),
    staticDir: path.join(home, "static"),
    logsDir: path.join(home, "logs"),
    stateDir: path.join(home, "state"),
    pidFile: path.join(home, "state", "cpa.pid"),
    installStateFile: path.join(home, "state", "install.json"),
    runtimeLogFile: path.join(home, "logs", "main.log"),
    minicpaLogFile: path.join(home, "state", "minicpa.log"),
  };
}

export function executableName(): string {
  return process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
}

export function activeExecutablePath(home: string): string {
  return path.join(home, executableName());
}

export function backupExecutablePath(home: string): string {
  return `${activeExecutablePath(home)}.bak`;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    fs.chmodSync(dir, 0o700);
  }
}
