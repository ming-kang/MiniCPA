import { execFileSync } from "node:child_process";
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

/**
 * PowerShell cold starts routinely exceed a few seconds on throttled machines;
 * remember which shell answered so later probes skip the dead candidate.
 */
let cachedPowerShell: string | undefined;

function runPowerShell(script: string, timeoutMs = 10_000): string | undefined {
  const shells = cachedPowerShell
    ? [cachedPowerShell, ...["powershell.exe", "pwsh.exe"].filter((s) => s !== cachedPowerShell)]
    : ["powershell.exe", "pwsh.exe"];
  for (const shell of shells) {
    try {
      const output = execFileSync(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
      }).trim();
      cachedPowerShell = shell;
      if (output) return output;
    } catch {
      /* try the other PowerShell executable */
    }
  }
  return undefined;
}

export type ProcessIdentity = "match" | "mismatch" | "unknown";

function readWindowsExecutablePath(pid: number): string | undefined {
  const script = [
    `$process = Get-Process -Id ${pid} -ErrorAction Stop`,
    "if ($process.Path) { [Console]::Out.Write($process.Path) }",
  ].join("; ");
  return runPowerShell(script);
}

/**
 * Classify whether `pid` is definitively the managed CPA binary.
 * A basename-only signal is useful for detecting a mismatch, but never enough to
 * authorize termination: another MiniCPA or unrelated process can share that name.
 */
export function classifyProcessIdentity(pid: number, expectedExe: string): ProcessIdentity {
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
      const executable = readWindowsExecutablePath(pid);
      if (executable) return exePathsMatch(executable, expected) ? "match" : "mismatch";

      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3000,
      }).trim();
      const image = parseTasklistImageName(out);
      if (!image) return "mismatch";
      return imageMatchesExpectedExe(image, expected) ? "unknown" : "mismatch";
    }

    if (process.platform === "darwin") {
      const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
        encoding: "utf8",
        timeout: 3000,
      }).trim();
      if (!out) return "mismatch";
      if (path.isAbsolute(out) && exePathsMatch(out, expected)) return "match";
      return imageMatchesExpectedExe(out, expected) ? "unknown" : "mismatch";
    }
  } catch {
    return "unknown";
  }

  return "unknown";
}

/** Stable process-creation marker used to detect PID reuse. */
export function readProcessStartMarker(pid: number): string | undefined {
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
      return runPowerShell(
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
          "[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)",
      );
    }
    if (process.platform === "darwin") {
      const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 3_000,
      }).trim();
      return output || undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
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
