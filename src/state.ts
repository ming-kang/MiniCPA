import fs from "node:fs";
import { writeFileAtomic } from "./fs-atomic.js";
import { cpaLayout, ensureDir } from "./paths.js";

export type InstallState = {
  runtimeVersion?: string;
};

export type PidRecord = {
  pid: number;
  exe: string;
  startedAt: string;
  startMarker?: string;
};

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

export function readInstallState(home: string): InstallState {
  const file = cpaLayout(home).installStateFile;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid MiniCPA install metadata: ${file}`);
    }
    if (!("runtimeVersion" in parsed)) return {};
    if (typeof parsed.runtimeVersion !== "string") {
      throw new Error(`Invalid runtimeVersion in MiniCPA install metadata: ${file}`);
    }
    return { runtimeVersion: parsed.runtimeVersion };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function writeInstallState(home: string, state: InstallState): void {
  const layout = cpaLayout(home);
  ensureDir(layout.stateDir);
  writeFileAtomic(
    layout.installStateFile,
    `${JSON.stringify({ runtimeVersion: state.runtimeVersion }, null, 2)}\n`,
  );
}

export function readPidRecord(home: string): PidRecord | undefined {
  const layout = cpaLayout(home);
  if (!fs.existsSync(layout.pidFile)) return undefined;
  const raw = fs.readFileSync(layout.pidFile, "utf8").trim();
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw) as Partial<PidRecord>;
    if (isPositiveInt(parsed.pid)) {
      return {
        pid: parsed.pid,
        exe: typeof parsed.exe === "string" ? parsed.exe : "",
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
        startMarker: typeof parsed.startMarker === "string" ? parsed.startMarker : undefined,
      };
    }
  } catch {
    /* legacy plain PID */
  }

  // Legacy plain integer PID only (reject "123abc" prefixes).
  if (!/^\d+$/.test(raw)) return undefined;
  const pid = Number.parseInt(raw, 10);
  if (!isPositiveInt(pid)) return undefined;
  return { pid, exe: "", startedAt: "", startMarker: undefined };
}

export function writePidRecord(home: string, record: PidRecord): void {
  const layout = cpaLayout(home);
  ensureDir(layout.stateDir);
  writeFileAtomic(layout.pidFile, `${JSON.stringify(record)}\n`);
}

export function clearPid(home: string): void {
  const layout = cpaLayout(home);
  try {
    fs.unlinkSync(layout.pidFile);
  } catch {
    /* best-effort */
  }
}
