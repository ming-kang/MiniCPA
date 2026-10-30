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

export function recentRuntimeLogs(home: string): string {
  const main = runtimeLogFile(home);
  const layout = cpaLayout(home);
  const files = fs.existsSync(main)
    ? [main, ...runtimeErrorLogFiles(home).slice(-1)]
    : [layout.errLogFile, layout.logFile];
  const tails = files.flatMap((file) => {
    const text = tailFile(file, 30);
    return text ? [`--- ${path.basename(file)} (tail) ---\n${text}`] : [];
  });
  return tails.length > 0 ? `\n${tails.join("\n")}` : "";
}
