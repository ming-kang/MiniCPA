import fs from "node:fs";
import { cpaLayout, ensureDir } from "./paths.js";

export type InstallState = {
  cpaHome: string;
  runtimeVersion?: string;
  panelVersion?: string;
  panelSha256?: string;
  lastUpdateCheck?: string;
  channel: "stable";
};

export function readInstallState(home: string): InstallState {
  const layout = cpaLayout(home);
  ensureDir(layout.stateDir);
  if (!fs.existsSync(layout.installStateFile)) {
    return { cpaHome: home, channel: "stable" };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(layout.installStateFile, "utf8")) as InstallState;
    return { ...parsed, channel: parsed.channel ?? "stable", cpaHome: home };
  } catch {
    return { cpaHome: home, channel: "stable" };
  }
}

export function writeInstallState(home: string, state: InstallState): void {
  const layout = cpaLayout(home);
  ensureDir(layout.stateDir);
  fs.writeFileSync(layout.installStateFile, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function readPid(home: string): number | undefined {
  const layout = cpaLayout(home);
  if (!fs.existsSync(layout.pidFile)) return undefined;
  const raw = fs.readFileSync(layout.pidFile, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) ? pid : undefined;
}

export function writePid(home: string, pid: number): void {
  const layout = cpaLayout(home);
  ensureDir(layout.stateDir);
  fs.writeFileSync(layout.pidFile, String(pid), "utf8");
}

export function clearPid(home: string): void {
  const layout = cpaLayout(home);
  if (fs.existsSync(layout.pidFile)) fs.unlinkSync(layout.pidFile);
}