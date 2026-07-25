import { spawn } from "node:child_process";
import fs from "node:fs";
import { createContext, printHome } from "../context.js";
import { buildCpaChildEnv } from "../process/child-env.js";
import { apiBaseUrl, managementUrl, readinessUrls, waitForAnyHttpOk, waitForHttpOk } from "../process/health.js";
import { resolveRunning, startDaemon, stopDaemon } from "../process/lifecycle.js";
import { withMiniCpaLock } from "../process/lock.js";
import { readCurrentRuntimeVersion, resolveRunnableExecutable } from "../process/runtime.js";
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

export async function runStart(opts: { noWait?: boolean }): Promise<void> {
  const ctx = createContext();
  const running = await withMiniCpaLock("start", () =>
    startDaemon(ctx.home, { noWait: opts.noWait }),
  );
  const base = apiBaseUrl(ctx.home);
  printHome(ctx);
  console.log(`Running   PID=${running.pid}`);
  console.log(`API       ${base}`);
  console.log(`Manage    ${managementUrl(ctx.home)}`);
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
  const base = apiBaseUrl(ctx.home);
  printHome(ctx);
  console.log(`Running   PID=${running.pid}`);
  console.log(`API       ${base}`);
  console.log(`Manage    ${managementUrl(ctx.home)}`);
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
    console.error(`CPA does not appear reachable at ${url}`);
    console.error("Run: cpa start");
    process.exitCode = 1;
    return;
  }
  await openInBrowser(url);
  console.log(url);
}

async function openInBrowser(url: string): Promise<void> {
  const command =
    process.platform === "win32"
      ? "rundll32.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
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
      console.error(`No log files yet under ${ctx.layout.logsDir}`);
      process.exitCode = 1;
      return;
    }
    await tailFollowMany(existing);
    return;
  }

  if (opts.errOnly) {
    if (!fs.existsSync(errFile)) {
      console.error(`Log not found: ${errFile}`);
      process.exitCode = 1;
      return;
    }
    printTail(errFile, n);
    return;
  }

  const hasOut = fs.existsSync(outFile);
  const hasErr = fs.existsSync(errFile);
  if (!hasOut && !hasErr) {
    console.error(`No log files yet under ${ctx.layout.logsDir}`);
    process.exitCode = 1;
    return;
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
    console.error("CPA is not running. Run: cpa start");
    process.exitCode = 1;
    return;
  }
  const exe = resolveRunnableExecutable(ctx.home);
  const child = spawn(exe, ["-config", ctx.layout.configFile, "-tui"], {
    cwd: ctx.home,
    stdio: "inherit",
    env: buildCpaChildEnv(),
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal ? `CPA TUI terminated by ${signal}` : `CPA TUI exited with code ${code ?? 1}`,
        ),
      );
    });
  });
}
