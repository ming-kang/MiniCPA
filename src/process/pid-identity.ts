import { runCommand } from "./runtime.js";
import { readWindowsProcess } from "./windows-process.js";
import fs from "node:fs";
import path from "node:path";

function basenameLower(filePath: string): string {
  return path.posix.basename(filePath.replace(/\\/g, "/")).toLowerCase();
}

function stripExeSuffix(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

export function imageMatchesExpectedExe(imageOrComm: string, expectedExe: string): boolean {
  const expected = stripExeSuffix(basenameLower(expectedExe));
  if (!expected) return false;
  const observed = stripExeSuffix(basenameLower(imageOrComm.trim()));
  if (!observed) return false;
  if (observed === expected) return true;
  // Linux /proc/pid/comm is truncated to 15 chars (TASK_COMM_LEN-1); allow prefix only then.
  if (observed.length === 15 && expected.startsWith(observed) && expected.length > 15) {
    return true;
  }
  return false;
}

export type ProcessIdentity = "match" | "mismatch" | "unknown";

// BSD ps truncates output columns to terminal width; a truncated path prefix must fail closed (unknown).
export function classifyDarwinComm(commOutput: string, expectedExe: string): ProcessIdentity {
  const out = commOutput.trim();
  if (!out) return "mismatch";
  if (path.isAbsolute(out)) {
    if (exePathsMatch(out, expectedExe)) return "match";
    if (expectedExe.startsWith(out) && out.length < expectedExe.length) return "unknown";
  }
  return imageMatchesExpectedExe(out, expectedExe) ? "unknown" : "mismatch";
}

export type IdentityFacts =
  | { kind: "executable"; executable?: string; errorCode?: string }
  | { kind: "comm"; comm?: string };

export function classifyIdentity(facts: IdentityFacts, expectedExe: string): ProcessIdentity {
  if (!expectedExe) return "unknown";
  if (facts.kind === "comm") {
    // A failed ps probe is unknown; empty output is an observed fact and stays mismatch.
    return facts.comm === undefined ? "unknown" : classifyDarwinComm(facts.comm, expectedExe);
  }
  if (facts.executable) {
    return exePathsMatch(facts.executable, expectedExe) ? "match" : "mismatch";
  }
  // ENOENT means the /proc/<pid>/exe entry is gone with the process, so it cannot be the expected exe.
  return facts.errorCode === "ENOENT" ? "mismatch" : "unknown";
}

async function probeLinuxExecutable(pid: number): Promise<IdentityFacts> {
  try {
    return { kind: "executable", executable: fs.readlinkSync(`/proc/${pid}/exe`) };
  } catch (error) {
    return { kind: "executable", errorCode: (error as NodeJS.ErrnoException).code };
  }
}

async function probeDarwinComm(pid: number): Promise<IdentityFacts> {
  try {
    // -ww sets unlimited termwidth; without it BSD ps truncates to 79 cols in pipes.
    const result = await runCommand("ps", ["-ww", "-p", String(pid), "-o", "comm="], {
      timeoutMs: 3000,
    });
    return result.code === 0 ? { kind: "comm", comm: result.stdout } : { kind: "comm" };
  } catch {
    return { kind: "comm" };
  }
}

function probeIdentityFacts(pid: number): Promise<IdentityFacts> {
  if (process.platform === "linux") return probeLinuxExecutable(pid);
  if (process.platform === "darwin") return probeDarwinComm(pid);
  return Promise.resolve({ kind: "executable" });
}

async function probeProcessFacts(
  pid: number,
): Promise<{ startMarker?: string; identityFacts: IdentityFacts }> {
  if (process.platform === "win32") {
    // One PowerShell probe yields both facts; probing them separately would double its cost.
    const { startMarker, executable } = await readWindowsProcess(pid);
    return { startMarker, identityFacts: { kind: "executable", executable } };
  }
  const [startMarker, identityFacts] = await Promise.all([
    readProcessStartMarker(pid),
    probeIdentityFacts(pid),
  ]);
  return { startMarker, identityFacts };
}

export async function readProcessStartMarker(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0) return undefined;
      const fields = stat
        .slice(closeParen + 1)
        .trim()
        .split(/\s+/);
      const startTicks = fields[19]; // proc(5) field 22; fields starts at field 3.
      if (!startTicks || !/^\d+$/.test(startTicks)) return undefined;
      let bootId = "boot";
      try {
        bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || bootId;
      } catch {
        /* best-effort */
      }
      return `${bootId}:${startTicks}`;
    }
    if (process.platform === "win32") {
      return (await readWindowsProcess(pid)).startMarker;
    }
    if (process.platform === "darwin") {
      // Pin TZ and LC_ALL: ps lstart formatting is locale and timezone sensitive.
      const result = await runCommand("ps", ["-ww", "-p", String(pid), "-o", "lstart="], {
        timeoutMs: 3_000,
        env: { TZ: "UTC", LC_ALL: "C", LC_TIME: "C" },
      });
      return result.code === 0 ? canonicalizeStartMarker(result.stdout) || undefined : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const C_LOCALE_MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** `[Www ]Mmm D HH:MM:SS YYYY` — the C-locale `ps -o lstart=` rendering. */
const LSTART_PATTERN =
  /^(?:[a-z]{3}\s+)?([a-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/i;

const LSTART_UTC_TAG = "lstart-utc:";
const TAGGED_START_MARKER_PATTERN = /^lstart-utc:-?\d+$/;

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isTaggedStartMarker(marker: string): boolean {
  return TAGGED_START_MARKER_PATTERN.test(marker.trim());
}

export function canonicalizeStartMarker(rawMarker: string): string {
  const collapsed = collapseWhitespace(rawMarker);
  const parts = LSTART_PATTERN.exec(collapsed);
  if (!parts) return collapsed;
  const month = C_LOCALE_MONTHS.indexOf(parts[1]?.toLowerCase() ?? "");
  if (month < 0) return collapsed;
  const epochMs = Date.UTC(
    Number(parts[6]),
    month,
    Number(parts[2]),
    Number(parts[3]),
    Number(parts[4]),
    Number(parts[5]),
  );
  if (!Number.isFinite(epochMs)) return collapsed;
  return `${LSTART_UTC_TAG}${Math.floor(epochMs / 1000)}`;
}

export function compareStartMarkers(
  recordedMarker?: string,
  currentMarker?: string,
): "same" | "reused" | "unknown" {
  const recorded = collapseWhitespace(recordedMarker ?? "");
  const current = collapseWhitespace(currentMarker ?? "");
  if (!recorded || !current || isTaggedStartMarker(recorded) !== isTaggedStartMarker(current)) {
    return "unknown";
  }
  return recorded === current ? "same" : "reused";
}

export function exePathsMatch(observedPath: string, expectedPath: string): boolean {
  try {
    const normalize = (filePath: string): string => {
      const cleaned = filePath.replace(/\s+\(deleted\)$/i, "").trim();
      try {
        return fs.realpathSync.native(cleaned);
      } catch {
        return path.resolve(cleaned);
      }
    };
    const a = normalize(observedPath);
    const b = normalize(expectedPath);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

export async function inspectProcessIdentity(
  pid: number,
  expectedExe: string,
): Promise<{
  currentMarker?: string;
  identity: ProcessIdentity;
}> {
  const { startMarker, identityFacts } = await probeProcessFacts(pid);
  return { currentMarker: startMarker, identity: classifyIdentity(identityFacts, expectedExe) };
}
