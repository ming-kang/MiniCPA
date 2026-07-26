import fs from "node:fs";
import { openInBrowser } from "../browser.js";
import { readCpaConfigWithWarnings } from "../config-yaml.js";
import { createContext, printHome } from "../context.js";
import { apiBaseUrl, managementUrl, readinessUrls, waitForAnyHttpOk, waitForHttpOk } from "../process/health.js";
import { resolveRunning, runCpaTuiProcess, startDaemon, stopDaemon } from "../process/lifecycle.js";
import { withMiniCpaLock } from "../process/lock.js";
import { readCurrentRuntimeVersion } from "../process/runtime.js";
import { tailFile } from "../util.js";

export function parseLogLineCount(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("--lines must be a positive whole number");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("--lines must be a positive whole number");
  }
  return parsed;
}

function printRunningSummary(ctx: ReturnType<typeof createContext>, pid: number): void {
  printHome(ctx);
  console.log(`Running   PID=${pid}`);
  console.log(`API       ${apiBaseUrl(ctx.home)}`);
  console.log(`Manage    ${managementUrl(ctx.home)}`);
}

export async function runStart(opts: { noWait?: boolean }): Promise<void> {
  const ctx = createContext();
  printConfigWarnings(ctx.layout.configFile);
  const running = await withMiniCpaLock("start", () =>
    startDaemon(ctx.home, { noWait: opts.noWait }),
  );
  printRunningSummary(ctx, running.pid);
}

/** Non-fatal: CPA is the authority on its config, but probes may target the wrong port. */
function printConfigWarnings(configFile: string): void {
  try {
    for (const warning of readCpaConfigWithWarnings(configFile).warnings) {
      console.error(`Warning: ${warning}`);
    }
  } catch {
    /* startDaemon will surface config errors with better context */
  }
}

export async function runStop(): Promise<void> {
  const ctx = createContext();
  const stopped = await withMiniCpaLock("stop", () => stopDaemon(ctx.home));
  printHome(ctx);
  console.log(stopped ? "Stopped" : "Not running");
}

export async function runRestart(opts: { noWait?: boolean }): Promise<void> {
  const ctx = createContext();
  const running = await withMiniCpaLock("restart", async () => {
    await stopDaemon(ctx.home);
    return startDaemon(ctx.home, { noWait: opts.noWait });
  });
  printRunningSummary(ctx, running.pid);
}

export async function runStatus(): Promise<void> {
  const ctx = createContext();
  const running = resolveRunning(ctx.home);
  const version = await readCurrentRuntimeVersion(ctx.home);
  printHome(ctx);
  console.log(`Version   ${version ?? "(not installed)"}`);
  if (running) {
    console.log(`Running   PID=${running.pid}`);
    if (running.startedAt) console.log(`Started   ${running.startedAt}`);
    console.log(`API       ${apiBaseUrl(ctx.home)}`);
    console.log(`Manage    ${managementUrl(ctx.home)}`);
    const reachable = await waitForAnyHttpOk(readinessUrls(ctx.home), 2000);
    console.log(`HTTP      ${reachable ? "ok" : "not reachable"}`);
    if (!reachable) {
      console.log("Hint     try: cpa restart   (or cpa logs --err)");
    }
    process.exitCode = reachable ? 0 : 1;
  } else {
    console.log("Running   no");
    process.exitCode = 1;
  }
}

export async function runOpen(): Promise<void> {
  const ctx = createContext();
  const url = managementUrl(ctx.home);
  const ok = await waitForHttpOk(url, 3000);
  if (!ok) {
    throw new Error(`CPA does not appear reachable at ${url}. Run: cpa start`);
  }
  await openInBrowser(url);
  console.log(url);
}

export async function runLogs(opts: {
  follow?: boolean;
  lines?: number;
  errOnly?: boolean;
}): Promise<void> {
  const ctx = createContext();
  const outFile = ctx.layout.logFile;
  const errFile = ctx.layout.errLogFile;
  const n = opts.lines ?? 80;

  if (opts.follow) {
    const files = opts.errOnly
      ? [errFile]
      : [outFile, errFile].filter((f) => fs.existsSync(f) || f === outFile);
    const existing = files.filter((f) => fs.existsSync(f));
    if (existing.length === 0) {
      throw new Error(`No log files yet under ${ctx.layout.logsDir}`);
    }
    await tailFollowMany(existing);
    return;
  }

  if (opts.errOnly) {
    if (!fs.existsSync(errFile)) {
      throw new Error(`Log not found: ${errFile}`);
    }
    printTail(errFile, n);
    return;
  }

  const hasOut = fs.existsSync(outFile);
  const hasErr = fs.existsSync(errFile);
  if (!hasOut && !hasErr) {
    throw new Error(`No log files yet under ${ctx.layout.logsDir}`);
  }

  if (hasOut) {
    console.log(`=== ${outFile} ===`);
    printTail(outFile, n);
  }
  if (hasErr) {
    if (hasOut) console.log("");
    console.log(`=== ${errFile} ===`);
    printTail(errFile, n);
  }
}

function printTail(file: string, n: number): void {
  console.log(tailFile(file, n));
}

async function tailFollowMany(files: string[]): Promise<void> {
  const state = new Map(files.map((f) => [f, fs.existsSync(f) ? fs.statSync(f).size : 0]));
  console.log(`Following ${files.join(" + ")} (Ctrl+C to exit)`);

  const interval = setInterval(() => {
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      let pos = state.get(file) ?? 0;
      if (stat.size < pos) pos = 0;
      if (stat.size > pos) {
        const fd = fs.openSync(file, "r");
        const len = Math.min(stat.size - pos, 8 * 1024 * 1024);
        const buf = Buffer.allocUnsafe(len);
        try {
          fs.readSync(fd, buf, 0, len, pos);
        } finally {
          fs.closeSync(fd);
        }
        state.set(file, pos + len);
        const prefix = files.length > 1 ? `[${file.endsWith(".err.log") ? "err" : "out"}] ` : "";
        const text = buf.toString();
        if (prefix) {
          for (const line of text.split(/\r?\n/)) {
            if (line.length) process.stdout.write(prefix + line + "\n");
          }
        } else {
          process.stdout.write(text);
        }
      }
    }
  }, 500);

  await new Promise<void>(() => {
    process.on("SIGINT", () => {
      clearInterval(interval);
      process.exit(0);
    });
  });
}

export async function runTui(): Promise<void> {
  const ctx = createContext();
  const running = resolveRunning(ctx.home);
  if (!running) {
    throw new Error("CPA is not running. Run: cpa start");
  }
  await runCpaTuiProcess(ctx.home);
}
