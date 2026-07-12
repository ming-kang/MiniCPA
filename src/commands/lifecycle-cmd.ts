import { spawn } from "node:child_process";
import fs from "node:fs";
import { createContext, printHome } from "../context.js";
import { apiBaseUrl, managementUrl, waitForHttpOk } from "../process/health.js";
import { resolveRunning, startDaemon, stopDaemon } from "../process/lifecycle.js";
import { readCurrentRuntimeVersion } from "../process/runtime.js";

export async function runStart(opts: { home?: string }): Promise<void> {
  const ctx = createContext(opts);
  const running = await startDaemon(ctx.home);
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

export async function runRestart(opts: { home?: string }): Promise<void> {
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
    console.log(`API       ${apiBaseUrl(ctx.home)}`);
    console.log(`Manage    ${managementUrl(ctx.home)}`);
    process.exitCode = 0;
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

export async function runLogs(opts: { home?: string; follow?: boolean; lines?: number }): Promise<void> {
  const ctx = createContext(opts);
  const file = ctx.layout.logFile;
  if (!fs.existsSync(file)) {
    console.error(`Log not found: ${file}`);
    process.exitCode = 1;
    return;
  }
  if (opts.follow) {
    await tailFollow(file);
    return;
  }
  const n = opts.lines ?? 80;
  const content = fs.readFileSync(file, "utf8").split(/\r?\n/);
  console.log(content.slice(-n).join("\n"));
}

async function tailFollow(file: string): Promise<void> {
  let pos = fs.statSync(file).size;
  console.log(`Following ${file} (Ctrl+C to exit)`);
  const interval = setInterval(() => {
    const stat = fs.statSync(file);
    if (stat.size < pos) pos = 0;
    if (stat.size > pos) {
      const fd = fs.openSync(file, "r");
      const len = stat.size - pos;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      fs.closeSync(fd);
      pos = stat.size;
      process.stdout.write(buf.toString());
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
  const { resolveRunnableExecutable } = await import("../process/runtime.js");
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