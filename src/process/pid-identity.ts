import { runCommand } from "./runtime.js";
import { readWindowsProcess } from "./windows-process.js";
import fs from "node:fs";
import path from "node:path";

function basenameLower(filePath: string): string {
  // Process metadata may contain a path from a different OS than the current
  // one (for example Windows tasklist output checked on a POSIX runner).
  return path.posix.basename(filePath.replace(/\\/g, "/")).toLowerCase();
}

function stripExeSuffix(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

/**
 * Match process image/comm against expected CPA executable basename.
 * Prefer exact basename equality; allow Linux 15-char comm truncation only
 * when the observed name is exactly 15 characters (kernel TASK_COMM_LEN-1).
 */
export function imageMatchesExpectedExe(imageOrComm: string, expectedExe: string): boolean {
  const expected = stripExeSuffix(basenameLower(expectedExe));
  if (!expected) return false;
  const observed = stripExeSuffix(basenameLower(imageOrComm.trim()));
  if (!observed) return false;
  if (observed === expected) return true;
  // Linux /proc/pid/comm is truncated to 15 characters — only then allow prefix.
  if (observed.length === 15 && expected.startsWith(observed) && expected.length > 15) {
    return true;
  }
  return false;
}

export type ProcessIdentity = "match" | "mismatch" | "unknown";

/**
 * Classify a Darwin `ps -o comm=` observation against the expected executable.
 *
 * BSD ps truncates its last output column, so a partial absolute path is a
 * routine observation and must never be read as evidence of a different
 * process: a strict prefix of the expected path resolves to "unknown", which is
 * fail-closed (no kill, no pid-file delete) rather than "mismatch".
 */
export function classifyDarwinComm(commOutput: string, expectedExe: string): ProcessIdentity {
  const out = commOutput.trim();
  if (!out) return "mismatch";
  if (path.isAbsolute(out)) {
    if (exePathsMatch(out, expectedExe)) return "match";
    if (expectedExe.startsWith(out) && out.length < expectedExe.length) return "unknown";
  }
  return imageMatchesExpectedExe(out, expectedExe) ? "unknown" : "mismatch";
}

/**
 * Classify whether `pid` is definitively the managed CPA binary.
 * A basename-only signal is useful for detecting a mismatch, but never enough to
 * authorize termination: another MiniCPA or unrelated process can share that name.
 */
export async function classifyProcessIdentity(
  pid: number,
  expectedExe: string,
): Promise<ProcessIdentity> {
  const expected = expectedExe || "";
  if (!expected) return "unknown";

  try {
    if (process.platform === "linux") {
      try {
        const exeLink = fs.readlinkSync(`/proc/${pid}/exe`);
        return exePathsMatch(exeLink, expected) ? "match" : "mismatch";
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // The process exited between the liveness and identity probes.
        return code === "ENOENT" ? "mismatch" : "unknown";
      }
    }

    if (process.platform === "win32") {
      const { executable } = await readWindowsProcess(pid);
      return executable ? (exePathsMatch(executable, expected) ? "match" : "mismatch") : "unknown";
    }

    if (process.platform === "darwin") {
      // -ww sets termwidth to unlimited; without it BSD ps truncates the last
      // column to the terminal width (79 columns when stdout is a pipe).
      const result = await runCommand("ps", ["-ww", "-p", String(pid), "-o", "comm="], {
        timeoutMs: 3000,
      });
      return result.code === 0 ? classifyDarwinComm(result.stdout, expected) : "unknown";
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}

/** Stable process-creation marker used to detect PID reuse. */
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
        /* start ticks remain stable for this boot */
      }
      return `${bootId}:${startTicks}`;
    }
    if (process.platform === "win32") {
      return (await readWindowsProcess(pid)).startMarker;
    }
    if (process.platform === "darwin") {
      // `lstart` is rendered in the caller's timezone and LC_TIME locale, so the
      // same live process yields different text from a cron job, a `sudo` shell
      // or after a timezone change. Pin both, then convert the pinned text to a
      // tagged absolute instant here, at read time, so the stored marker carries
      // the timezone it was read in instead of leaving it to be guessed later.
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

/**
 * Prefix of the self-identifying Darwin marker this build writes.
 *
 * MiniCPA <= 0.1.0 stored the raw `ps -o lstart=` text with no TZ/locale pin, so
 * a recorded marker from that era is always wall-clock text and can never begin
 * with this tag. That is what makes the two generations distinguishable.
 */
const LSTART_UTC_TAG = "lstart-utc:";

/** A marker already reduced to an absolute instant by this build. */
const TAGGED_START_MARKER_PATTERN = /^lstart-utc:-?\d+$/;

/** Collapse incidental whitespace so otherwise identical markers compare equal. */
function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * True when a marker carries this build's timezone-explicit tag.
 *
 * Tagged and untagged markers are NOT comparable: an untagged Darwin marker is
 * wall-clock text in an unknown timezone and unknown locale, so no comparison
 * against a tagged marker can prove anything.
 */
export function isTaggedStartMarker(marker: string): boolean {
  return TAGGED_START_MARKER_PATTERN.test(marker.trim());
}

/**
 * Reduce a freshly read Darwin `lstart` rendering to `lstart-utc:<epoch seconds>`.
 *
 * The wall-clock text is interpreted as UTC, which is only correct because
 * `readProcessStartMarker` pins `TZ=UTC`/`LC_ALL=C` for the probe that produced
 * it. It is therefore a read-time conversion, NOT a repair for stored values:
 * applying it to a marker recorded by an older, unpinned build would silently
 * reinterpret local wall-clock text as UTC and shift the instant by the
 * machine's UTC offset. Cross-generation comparison is handled by
 * `startMarkersProveReuse`, which refuses to compare the two shapes at all.
 *
 * Every other marker shape (Linux `<boot id>:<ticks>`, Windows tick counts,
 * already-tagged values) is passed through with whitespace collapsed.
 */
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

/**
 * Decide whether two start markers are in a mutually comparable format.
 *
 * Missing or empty markers on either side are never comparable. A tagged
 * UTC instant (`lstart-utc:<epoch seconds>`) cannot be compared against a
 * legacy untagged Darwin wall-clock marker because the legacy marker's timezone
 * and locale are unknown.
 */
export function areStartMarkersComparable(
  recordedMarker?: string,
  currentMarker?: string,
): boolean {
  const recorded = collapseWhitespace(recordedMarker ?? "");
  const current = collapseWhitespace(currentMarker ?? "");
  if (!recorded || !current) return false;
  return isTaggedStartMarker(recorded) === isTaggedStartMarker(current);
}

/**
 * Decide whether two start markers PROVE the PID was reused.
 *
 * Deliberately fail-open, in three steps that all resolve to "cannot prove":
 * a missing marker on either side; markers of different shapes (a legacy
 * untagged Darwin wall-clock marker read back by a build that now writes tagged
 * instants, in either direction); and, only when both are comparable, equal
 * values. Reuse is reported solely for two comparable markers that differ.
 *
 * The cost is that macOS loses reuse detection for exactly one generation after
 * an upgrade, until the next `cpa start` rewrites the marker. That is the right
 * trade: an unproven reuse must never authorize terminating a process or
 * deleting a live PID record.
 */
export function startMarkersProveReuse(recordedMarker?: string, currentMarker?: string): boolean {
  const recorded = collapseWhitespace(recordedMarker ?? "");
  const current = collapseWhitespace(currentMarker ?? "");
  if (!areStartMarkersComparable(recorded, current)) return false;
  return recorded !== current;
}

/**
 * Decide whether two start markers PROVE identity (that the PID is the same process).
 *
 * Only two comparable markers with identical values prove ownership. Incomparable
 * markers (such as a legacy untagged Darwin marker vs. a tagged UTC instant)
 * cannot prove identity. Missing markers on either side also cannot prove identity.
 */
export function startMarkersProveIdentity(
  recordedMarker?: string,
  currentMarker?: string,
): boolean {
  const recorded = collapseWhitespace(recordedMarker ?? "");
  const current = collapseWhitespace(currentMarker ?? "");
  if (!areStartMarkersComparable(recorded, current)) return false;
  return recorded === current;
}

export type PidMarkerProbeResult = {
  currentMarker?: string;
  reused: boolean;
  matched: boolean;
};

/**
 * Shared PID-reuse and identity predicate for lifecycle and lock recovery.
 *
 * `readMarker` exists so tests can supply a marker shape from another platform;
 * production callers use the default probe.
 */
export async function probePidReuse(
  pid: number,
  recordedMarker?: string,
  readMarker: (
    pid: number,
  ) => string | undefined | Promise<string | undefined> = readProcessStartMarker,
): Promise<PidMarkerProbeResult> {
  const currentMarker = await readMarker(pid);
  return {
    currentMarker,
    reused: startMarkersProveReuse(recordedMarker, currentMarker),
    matched: startMarkersProveIdentity(recordedMarker, currentMarker),
  };
}

/** True only when full paths resolve to the same executable. */
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

/** Parse tasklist CSV /NH first field (image name). */
export function parseTasklistImageName(tasklistOutput: string): string | undefined {
  const line = tasklistOutput.trim().split(/\r?\n/)[0] ?? "";
  if (!line || /^INFO:/i.test(line)) return undefined;
  const quoted = line.match(/^"([^"]+)"/);
  if (quoted?.[1]) return quoted[1];
  const first = line.split(",")[0]?.replace(/^"|"$/g, "").trim();
  return first || undefined;
}

/** Snapshot scope is one inspection; destructive callers must always take a fresh snapshot. */
export async function inspectProcessIdentity(
  pid: number,
  expectedExe: string,
): Promise<{
  currentMarker?: string;
  identity: ProcessIdentity;
}> {
  if (process.platform === "win32") {
    const facts = await readWindowsProcess(pid);
    return {
      currentMarker: facts.startMarker,
      identity:
        expectedExe && facts.executable
          ? exePathsMatch(facts.executable, expectedExe)
            ? "match"
            : "mismatch"
          : "unknown",
    };
  }
  const [currentMarker, identity] = await Promise.all([
    readProcessStartMarker(pid),
    classifyProcessIdentity(pid, expectedExe),
  ]);
  return { currentMarker, identity };
}
