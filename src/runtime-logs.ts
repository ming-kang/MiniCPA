import fs from "node:fs";
import path from "node:path";
import { cpaLayout } from "./paths.js";
import { tailFile } from "./util.js";

// CLIProxyAPI honors WRITABLE_PATH; otherwise writes relative to its home/cwd.
export function runtimeLogDirectory(home: string): string {
  const writable = process.env.WRITABLE_PATH?.trim() || process.env.writable_path?.trim();
  return writable ? path.resolve(home, writable, "logs") : cpaLayout(home).logsDir;
}

export function runtimeLogFile(home: string): string {
  return path.join(runtimeLogDirectory(home), "main.log");
}

export function runtimeErrorLogFiles(home: string): string[] {
  const directory = runtimeLogDirectory(home);
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && entry.name.startsWith("error-") && entry.name.endsWith(".log"),
      )
      .flatMap((entry) => {
        const file = path.join(directory, entry.name);
        try {
          return [{ file, modified: fs.statSync(file).mtimeMs }];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      })
      .sort((a, b) => a.modified - b.modified || a.file.localeCompare(b.file))
      .slice(-10)
      .map(({ file }) => file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function runtimeLogSize(home: string): number {
  try {
    return fs.statSync(runtimeLogFile(home)).size;
  } catch {
    return 0;
  }
}

/** The last main.log lines, limited to what was written after byte offset `since`. */
export function recentRuntimeLogs(home: string, since = 0): string {
  const size = runtimeLogSize(home);
  // A file smaller than `since` was rotated in between, so all of it is new.
  const fresh = size >= since ? size - since : size;
  return fresh > 0 ? tailFile(runtimeLogFile(home), 30, fresh) : "";
}
