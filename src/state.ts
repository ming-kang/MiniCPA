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

/** Process ownership record (JSON in cpa.pid). Legacy plain PID still accepted. */
export type PidRecord = {
  pid: number;
  exe: string;
  startedAt: string;
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

export function readPidRecord(home: string): PidRecord | undefined {
  const layout = cpaLayout(home);
  if (!fs.existsSync(layout.pidFile)) return undefined;
  const raw = fs.readFileSync(layout.pidFile, "utf8").trim();
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as Partial<PidRecord>;
    if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid)) {
      return {
        pid: parsed.pid,
        exe: typeof parsed.exe === "string" ? parsed.exe : "",
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      };
    }
  } catch {
    /* legacy plain PID */
  }

  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid)) return undefined;
  return { pid, exe: "", startedAt: "" };
}

/** @deprecated prefer readPidRecord */
export function readPid(home: string): number | undefined {
  return readPidRecord(home)?.pid;
}

export function writePidRecord(home: string, record: PidRecord): void {
  const layout = cpaLayout(home);
  ensureDir(layout.stateDir);
  fs.writeFileSync(layout.pidFile, JSON.stringify(record) + "\n", "utf8");
}

/** @deprecated prefer writePidRecord */
export function writePid(home: string, pid: number, exe = ""): void {
  writePidRecord(home, { pid, exe, startedAt: new Date().toISOString() });
}

export function clearPid(home: string): void {
  const layout = cpaLayout(home);
  if (fs.existsSync(layout.pidFile)) fs.unlinkSync(layout.pidFile);
}
