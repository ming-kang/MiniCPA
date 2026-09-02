import fs from "node:fs";
import { openInBrowser } from "../browser.js";
import { readCpaConfigWithWarnings } from "../config-yaml.js";
import { createContext, printHome } from "../context.js";
import { tailFollowMany } from "./log-follow.js";
import { recordMiniCpaEvent } from "../minicpa-log.js";
import { inspectAutostartState, type AutostartState } from "../process/autostart.js";
import {
  apiBaseUrl,
  managementUrl,
  readinessUrls,
  waitForAnyHttpOk,
  waitForHttpOk,
} from "../process/health.js";
import { inspectRunning, startDaemon, stopDaemon, type RunningInfo } from "../process/lifecycle.js";
import { withMiniCpaLock } from "../process/lock.js";
import {
  inspectRunnableExecutable,
  inspectRuntimeInstallation,
  runRuntimeAttached,
} from "../process/runtime.js";
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
  console.log(`Status     running (PID=${pid})`);
  console.log(`API        ${apiBaseUrl(ctx.home)}`);
  console.log(`Web        ${managementUrl(ctx.home)}`);
}

/**
 * Start CLIProxyAPI, recording the outcome in MiniCPA's own event log.
 *
 * The record is here for the autostart path: at login the launcher discards this
 * process's output, and the failures that matter most there (missing config,
 * missing binary, a held lock) all happen before the CPA child exists, so they
 * reach neither the terminal nor `cpa.err.log`. Successes are recorded too —
 * that is what makes an empty log meaningful, because it then means the launcher
 * never fired rather than "it fired and worked".
 */
export async function runStart(opts: { noWait?: boolean }): Promise<void> {
  const ctx = createContext();
  printConfigWarnings(ctx.layout.configFile);
  let running: RunningInfo;
  try {
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
  console.log(stopped ? "CLIProxyAPI stopped" : "CLIProxyAPI is not running");
}

export async function runRestart(opts: { noWait?: boolean }): Promise<void> {
  const ctx = createContext();
  const running = await withMiniCpaLock("restart", async () => {
    await stopDaemon(ctx.home);
    return startDaemon(ctx.home, { noWait: opts.noWait });
  });
  printRunningSummary(ctx, running.pid);
}

export type StatusDependencies = {
  inspectAutostartState?: () => Promise<AutostartState>;
};

export async function runStatus(deps?: StatusDependencies): Promise<void> {
  const ctx = createContext();
  // Read-only: an unlocked command must not repair (or race) the instance home.
  const running = inspectRunning(ctx.home);
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
  printHome(ctx);
  console.log(`Version    ${version ?? (installed.executable ? "(unknown)" : "(not installed)")}`);
  console.log(`Autostart  ${autostart}`);
  if (autostartWarning) {
    console.error(`Warning: could not inspect autostart: ${autostartWarning}`);
  }
  if (running) {
    console.log(`Status     running (PID=${running.pid})`);
    if (running.startedAt) console.log(`Started    ${running.startedAt}`);
    console.log(`API        ${apiBaseUrl(ctx.home)}`);
    console.log(`Web        ${managementUrl(ctx.home)}`);
    const reachable = await waitForAnyHttpOk(readinessUrls(ctx.home), 2000);
    console.log(`HTTP       ${reachable ? "ok" : "not reachable"}`);
    if (!reachable) {
      console.log("Hint       Try: cpa restart (or cpa logs --err)");
    }
    process.exitCode = reachable ? 0 : 1;
  } else {
    console.log("Status     stopped");
    process.exitCode = 1;
  }
}

/**
 * Name of the missing launcher when a browser could not be spawned at all.
 *
 * Node reports this as `spawn <command> ENOENT`; a headless Linux box, a WSL
 * shell or a container simply has no `xdg-open`, which must not turn `cpa web`
 * into a failed command — the URL is already on stdout.
 */
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
  /** Test seams; production waits long enough for CLIProxyAPI's first panel download. */
  initialPanelWaitMs?: number;
  serverWaitMs?: number;
  panelBootstrapWaitMs?: number;
}): Promise<void> {
  const ctx = createContext();
  const config = readCpaConfigWithWarnings(ctx.layout.configFile).config;
  if (config["remote-management"]?.["disable-control-panel"] === true) {
    throw new Error(
      "Web management panel is disabled by remote-management.disable-control-panel in config.yaml",
    );
  }

  const url = managementUrl(ctx.home);
  let ok = await waitForHttpOk(url, deps?.initialPanelWaitMs ?? 3000);
  if (!ok) {
    // The first request can trigger CLIProxyAPI's own management.html download,
    // which current upstream detaches from the client request. Distinguish an
    // offline server quickly, then give that download its full HTTP budget.
    const serverUp = await waitForHttpOk(`${apiBaseUrl(ctx.home)}/`, deps?.serverWaitMs ?? 2000);
    if (!serverUp) {
      throw new Error(`CLIProxyAPI is not reachable at ${url}. Run: cpa start`);
    }
    ok = await waitForHttpOk(url, deps?.panelBootstrapWaitMs ?? 35_000);
    if (!ok) {
      throw new Error(
        `Web management panel is unavailable at ${url}. CLIProxyAPI manages this asset; check: cpa logs --err`,
      );
    }
  }
  // Print before launching: the URL is the useful output even when no browser
  // can be started.
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
    const files = (opts.errOnly ? [errFile] : [outFile, errFile]).filter((f) => fs.existsSync(f));
    if (files.length === 0) {
      throw new Error(`No log files yet under ${ctx.layout.logsDir}`);
    }
    await tailFollowMany(files);
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

export type TuiDeps = {
  inspectRunning?: typeof inspectRunning;
  runRuntimeAttached?: typeof runRuntimeAttached;
};

/**
 * Attach the official CPA terminal UI to this terminal.
 *
 * `cpa tui` holds no MiniCPA lock, so every step here is a read: it resolves the
 * executable with inspectRunnableExecutable instead of the repairing
 * resolveRunnableExecutable, which would rename a crashed unlock probe or copy
 * `.bak` over the very binary a lock-holding `cpa update` is replacing.
 */
export async function runTui(deps?: TuiDeps): Promise<void> {
  const ctx = createContext();
  const inspect = deps?.inspectRunning ?? inspectRunning;
  const running = inspect(ctx.home);
  if (!running) {
    throw new Error("CLIProxyAPI is not running. Run: cpa start");
  }
  const found = inspectRunnableExecutable(ctx.home);
  if (!found) {
    throw new Error(`CLIProxyAPI binary not found under ${ctx.home}. Run: cpa update`);
  }
  if (found.kind !== "active") {
    // Recovering the residue here would be a write from an unlocked command, so
    // report it and run the file where it lies; `cpa start` renames it back.
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
