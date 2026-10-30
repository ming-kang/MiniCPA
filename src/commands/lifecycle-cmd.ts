import fs from "node:fs";
import { openInBrowser } from "../browser.js";
import { createContext, printHome } from "../context.js";
import { describeDownloadRoute } from "../http.js";
import { recordMiniCpaEvent } from "../minicpa-log.js";
import { inspectAutostartState, type AutostartState } from "../process/autostart.js";
import { apiBaseUrl, managementUrl, readinessUrls, waitForAnyHttpOk } from "../process/health.js";
import { inspectRunning, startDaemon, stopDaemon, type RunningInfo } from "../process/lifecycle.js";
import { withMiniCpaLock } from "../process/lock.js";
import {
  inspectRunnableExecutable,
  inspectRuntimeInstallation,
  runRuntimeAttached,
} from "../process/runtime.js";
function printRunningSummary(ctx: ReturnType<typeof createContext>, pid: number): void {
  printHome(ctx);
  console.log(`Status     running (PID=${pid})`);
  console.log(`API        ${apiBaseUrl()}`);
  console.log(`Web        ${managementUrl()}`);
}

export async function runStart(opts: { noWait?: boolean }): Promise<void> {
  const ctx = createContext();
  let running: RunningInfo;
  try {
    apiBaseUrl();
    running = await withMiniCpaLock("start", () => startDaemon(ctx.home, { noWait: opts.noWait }));
  } catch (err) {
    recordMiniCpaEvent(
      ctx.home,
      "error",
      `start failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
  recordMiniCpaEvent(ctx.home, "info", `start ok pid=${running.pid}`);
  printRunningSummary(ctx, running.pid);
}

export async function runStop(): Promise<void> {
  const ctx = createContext();
  const stopped = await withMiniCpaLock("stop", () => stopDaemon(ctx.home));
  printHome(ctx);
  console.log(stopped ? "CLIProxyAPI stopped" : "CLIProxyAPI is not running");
}

export async function runRestart(opts: { noWait?: boolean }): Promise<void> {
  const ctx = createContext();
  apiBaseUrl();
  const running = await withMiniCpaLock("restart", async () => {
    await stopDaemon(ctx.home);
    return startDaemon(ctx.home, { noWait: opts.noWait });
  });
  printRunningSummary(ctx, running.pid);
}

export type StatusDependencies = {
  inspectAutostartState?: () => Promise<AutostartState>;
};

export async function runStatus(cliVersion: string, deps?: StatusDependencies): Promise<void> {
  const ctx = createContext();
  // Read-only: an unlocked command must not repair (or race) the instance home.
  const running = await inspectRunning(ctx.home);
  const installed = inspectRuntimeInstallation(ctx.home);
  const version =
    installed.executable?.kind === "active" ? installed.state.runtimeVersion : undefined;
  let autostart: AutostartState | "unknown" = "unknown";
  let autostartWarning: string | undefined;
  try {
    autostart = await (deps?.inspectAutostartState ?? inspectAutostartState)();
  } catch (err) {
    autostartWarning = err instanceof Error && err.message ? err.message : String(err);
  }
  const row = (label: string, value: string): void => console.log(`${label.padEnd(17)}${value}`);
  const hasConfig = fs.existsSync(ctx.layout.configFile);
  row("Source", hasConfig ? "Local File" : "Not initialized");
  row("MiniCPA Version", cliVersion);
  row("Core Version", version ?? (installed.executable ? "(unknown)" : "(not installed)"));
  row("Download Via", describeDownloadRoute());
  row("Local API", apiBaseUrl());
  row("Web Panel", managementUrl());
  row("Core Config", ctx.layout.configFile);
  row("Home", ctx.home);
  row("Autostart", autostart);
  if (autostartWarning) {
    console.error(`Warning: could not inspect autostart: ${autostartWarning}`);
  }
  if (running) {
    row(
      "Status",
      `running (PID=${running.pid})${running.identityUnknown ? " · identity unverified" : ""}`,
    );
    if (running.startedAt) row("Started", running.startedAt);
    const reachable = await waitForAnyHttpOk(readinessUrls(), 2000);
    row("HTTP", reachable ? "ok" : "not reachable");
    if (!reachable) {
      row("Hint", "Try: cpa restart (or cpa logs)");
    }
    process.exitCode = reachable ? 0 : 1;
  } else {
    row("Status", "stopped");
    process.exitCode = 1;
  }
}

function missingBrowserCommand(err: unknown): string | undefined {
  const errno = err as NodeJS.ErrnoException;
  const message = typeof errno?.message === "string" ? errno.message : "";
  const match = /^spawn (.+) ENOENT$/.exec(message);
  if (match?.[1]) return match[1];
  if (errno?.code === "ENOENT") return errno.path || "browser launcher";
  return undefined;
}

export async function runOpen(deps?: {
  openInBrowser?: (url: string) => Promise<void>;
}): Promise<void> {
  createContext();
  const url = managementUrl();
  console.log(url);
  const open = deps?.openInBrowser ?? openInBrowser;
  try {
    await open(url);
  } catch (err) {
    const missing = missingBrowserCommand(err);
    if (missing === undefined) throw err;
    console.error(`Warning: could not open a browser (${missing} not found)`);
    console.error("Open the URL above manually.");
  }
}

export type TuiDeps = {
  inspectRunning?: typeof inspectRunning;
  runRuntimeAttached?: typeof runRuntimeAttached;
};

// cpa tui holds no lock, so it must not trigger repairing resolvers.
export async function runTui(deps?: TuiDeps): Promise<void> {
  const ctx = createContext();
  const inspect = deps?.inspectRunning ?? inspectRunning;
  const running = await inspect(ctx.home);
  if (!running) {
    throw new Error("CLIProxyAPI is not running. Run: cpa start");
  }
  const found = inspectRunnableExecutable(ctx.home);
  if (!found) {
    throw new Error(`CLIProxyAPI binary not found under ${ctx.home}. Run: cpa update`);
  }
  if (found.kind !== "active") {
    console.error(
      `Warning: the active binary is missing; running the TUI from ${found.path} — run: cpa start to recover it`,
    );
  }
  const run = deps?.runRuntimeAttached ?? runRuntimeAttached;
  await run(found.path, ["-config", ctx.layout.configFile, "-tui"], {
    cwd: ctx.home,
    label: "CLIProxyAPI TUI",
  });
}
