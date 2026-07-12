import { spawn } from "node:child_process";
import fs from "node:fs";
import { createContext, printHome } from "../context.js";
import { apiBaseUrl, managementUrl, waitForHttpOk } from "../process/health.js";
import { resolveRunning, startDaemon, stopDaemon } from "../process/lifecycle.js";
import { readCurrentRuntimeVersion, resolveRunnableExecutable } from "../process/runtime.js";

export async function runStart(opts: { home?: string; noWait?: boolean }): Promise<void> {
  const ctx = createContext(opts);
  const running = await startDaemon(ctx.home, { noWait: opts.noWait });
  const base = apiBaseUrl(ctx.home);
  printHome(ctx);
  console.log(`Running   PID=${running.pid}`);
  console.log(`API       ${base}`);
  console.log(`Manage    ${managementUrl(ctx.home)}`);
}

export async function runStop(opts: { home?: string }): Promise<void> {
  const ctx = createContext(opts);
  const stopped = await stopDaemon(ctx.home);
  printHome(ctx);
  console.log(stopped ? "Stopped" : "Not running");
}

export async function runRestart(opts: { home?: string; noWait?: boolean }): Promise<void> {
  await runStop(opts);
  await runStart(opts);
}

export async function runStatus(opts: { home?: string }): Promise<void> {
  const ctx = createContext(opts);
  const running = resolveRunning(ctx.home);
  const version = await readCurrentRuntimeVersion(ctx.home);
  printHome(ctx);
  console.log(`Version   ${version ?? "(not installed)"}`);
  if (running) {
    console.log(`Running   PID=${running.pid}`);
    if (running.startedAt) console.log(`Started   ${running.startedAt}`);
    console.log(`API       ${apiBaseUrl(ctx.home)}`);
    console.log(`Manage    ${managementUrl(ctx.home)}`);
    const reachable = await waitForHttpOk(managementUrl(ctx.home), 2000);
    console.log(`HTTP      ${reachable ? "ok" : "not reachable"}`);
    process.exitCode = reachable ? 0 : 1;
  } else {
    console.log("Running   no");
    process.exitCode = 1;
  }
}

export async function runOpen(opts: { home?: string }): Promise<void> {
  const ctx = createContext(opts);
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
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

export async function runLogs(opts: {
  home?: string;
  follow?: boolean;
  lines?: number;
  errOnly?: boolean;
}): Promise<void> {
  const ctx = createContext(opts);
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
  const content = fs.readFileSync(file, "utf8").split(/\r?\n/);
  console.log(content.slice(-n).join("\n"));
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
        const len = stat.size - pos;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        fs.closeSync(fd);
        state.set(file, stat.size);
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

export async function runTui(opts: { home?: string }): Promise<void> {
  const ctx = createContext(opts);
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
    env: process.env,
  });
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
  });
}
