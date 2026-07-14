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
 * Prefer exact basename equality; allow truncated comm (Linux 15-char limit).
 */
export function imageMatchesExpectedExe(imageOrComm: string, expectedExe: string): boolean {
  const expected = stripExeSuffix(basenameLower(expectedExe));
  if (!expected) return false;
  const observed = stripExeSuffix(basenameLower(imageOrComm.trim()));
  if (!observed) return false;
  if (observed === expected) return true;
  // Linux /proc/pid/comm is often truncated to 15 characters
  if (observed.length <= 15 && expected.startsWith(observed)) return true;
  return false;
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
