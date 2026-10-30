import fs from "node:fs";
import { createContext } from "../context.js";
import { runtimeErrorLogFiles, runtimeLogDirectory, runtimeLogFile } from "../runtime-logs.js";
import { tailFile } from "../util.js";
import { tailFollowMany } from "./log-follow.js";

export function parseLogLineCount(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("--lines must be a positive whole number");
  }
  return Number(value);
}

export async function runLogs(opts: {
  follow?: boolean;
  lines?: number;
  errOnly?: boolean;
  legacy?: boolean;
}): Promise<void> {
  const { home, layout } = createContext();
  const main = runtimeLogFile(home);
  const nativeFiles = opts.legacy
    ? []
    : opts.errOnly
      ? runtimeErrorLogFiles(home)
      : [main].filter((file) => fs.existsSync(file));
  const legacyFiles = (
    opts.errOnly ? [layout.errLogFile] : [layout.logFile, layout.errLogFile]
  ).filter((file) => fs.existsSync(file));
  const useLegacy =
    opts.legacy || (!fs.existsSync(main) && nativeFiles.length === 0 && legacyFiles.length > 0);
  const files = useLegacy ? legacyFiles : nativeFiles;
  if (useLegacy && !opts.legacy) {
    console.error(
      "Warning: showing legacy stdout/stderr history. New starts use CLIProxyAPI native logs.",
    );
  }
  if (opts.follow && opts.errOnly && !useLegacy && fs.existsSync(runtimeLogDirectory(home))) {
    // Dynamic error-log polling discovers newly created request error log files.
    await tailFollowMany(() => runtimeErrorLogFiles(home));
    return;
  }
  if (files.length === 0) {
    throw new Error(
      opts.errOnly
        ? `Log not found: ${useLegacy ? layout.errLogFile : `${runtimeLogDirectory(home)}/error-*.log`}`
        : `No log files yet under ${useLegacy ? layout.logsDir : runtimeLogDirectory(home)} (configure native logging in CLIProxyAPI)`,
    );
  }
  if (opts.follow) {
    await tailFollowMany(files);
    return;
  }
  for (const [index, file] of files.entries()) {
    if (index > 0) console.log("");
    if (!(useLegacy && opts.errOnly)) console.log(`=== ${file} ===`);
    console.log(tailFile(file, opts.lines ?? 80));
  }
}
