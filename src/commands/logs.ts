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
}): Promise<void> {
  const { home } = createContext();
  const directory = runtimeLogDirectory(home);
  if (opts.follow && opts.errOnly && fs.existsSync(directory)) {
    // Dynamic error-log polling discovers newly created request error log files.
    await tailFollowMany(() => runtimeErrorLogFiles(home));
    return;
  }
  const main = runtimeLogFile(home);
  const files = opts.errOnly ? runtimeErrorLogFiles(home) : fs.existsSync(main) ? [main] : [];
  if (files.length === 0) {
    throw new Error(
      opts.errOnly
        ? `No request-error logs in ${directory}`
        : `No CLIProxyAPI log in ${directory} yet. It appears once CLIProxyAPI runs with logging-to-file enabled (cpa init enables it).`,
    );
  }
  if (opts.follow) {
    await tailFollowMany(files);
    return;
  }
  for (const [index, file] of files.entries()) {
    if (index > 0) console.log("");
    console.log(`=== ${file} ===`);
    console.log(tailFile(file, opts.lines ?? 80));
  }
}
