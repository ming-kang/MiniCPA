import fs from "node:fs";
import { openInBrowser } from "../browser.js";
import { createContext, printRow } from "../context.js";
import { describeDownloadRoute } from "../http.js";
import { readLastMiniCpaEvent, recordMiniCpaEvent } from "../minicpa-log.js";
import { isProcessAlive } from "../process/alive.js";
import {
  describeAutostartState,
  inspectAutostartState,
  type AutostartState,
} from "../process/autostart.js";
import { apiBaseUrl, managementUrl, readinessUrls, waitForAnyHttpOk } from "../process/health.js";
import {
  inspectRunning,
  StartFailure,
  startDaemon,
  stopDaemon,
  type RunningInfo,
  type StartResult,
} from "../process/lifecycle.js";
import { withMiniCpaLock } from "../process/lock.js";
import {
  inspectRunnableExecutable,
  inspectRuntimeInstallation,
  runRuntimeAttached,
  type RuntimeInstallationInspection,
} from "../process/runtime.js";
import { readPidRecord } from "../state.js";

function printStarted(result: StartResult, verb: "started" | "restarted"): void {
  console.log(
    result.alreadyRunning
      ? `CLIProxyAPI is already running (PID ${result.pid})`
      : `CLIProxyAPI ${verb} (PID ${result.pid})`,
  );
  printRow("API", apiBaseUrl());
  printRow("Web", managementUrl());
}

export async function runStart(opts: { noWait?: boolean }): Promise<void> {
  const ctx = createContext();
  let result: StartResult;
  try {
    apiBaseUrl();
    result = await withMiniCpaLock("start", () => startDaemon(ctx.home, { noWait: opts.noWait }));
  } catch (err) {
    const reason =
      err instanceof StartFailure ? err.summary : err instanceof Error ? err.message : String(err);
    recordMiniCpaEvent(ctx.home, "error", `start failed: ${reason}`);
    throw err;
  }
  recordMiniCpaEvent(ctx.home, "info", `start ok pid=${result.pid}`);
  printStarted(result, "started");
}

export async function runStop(): Promise<void> {
  const ctx = createContext();
  const stopped = await withMiniCpaLock("stop", () => stopDaemon(ctx.home));
  console.log(stopped ? "CLIProxyAPI stopped" : "CLIProxyAPI is not running");
}

export async function runRestart(opts: { noWait?: boolean }): Promise<void> {
  const ctx = createContext();
  apiBaseUrl();
  const result = await withMiniCpaLock("restart", async () => {
    await stopDaemon(ctx.home);
    return startDaemon(ctx.home, { noWait: opts.noWait });
  });
  printStarted(result, "restarted");
}

export function formatUptime(startedAt: string | undefined, now = Date.now()): string | undefined {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(started) || started > now) return undefined;
  const minutes = Math.floor((now - started) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `up ${days}d ${hours}h`;
  if (hours > 0) return `up ${hours}h ${minutes % 60}m`;
  return minutes > 0 ? `up ${minutes}m` : "up <1m";
}

/** `YYYY-MM-DD HH:MM` in local time; events are stored as UTC ISO strings. */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusLine(running: RunningInfo | undefined, initialized: boolean): string {
  if (!running) return initialized ? "stopped (run: cpa start)" : "not initialized (run: cpa init)";
  const details = [
    `PID ${running.pid}`,
    formatUptime(running.startedAt),
    running.identityUnknown ? "identity unverified" : undefined,
  ].filter((detail) => detail !== undefined);
  return `running (${details.join(", ")})`;
}

function detectProblems(
  home: string,
  installed: RuntimeInstallationInspection,
  running: RunningInfo | undefined,
  reachable: boolean,
): string[] {
  const problems: string[] = [];
  const executable = installed.executable;
  if (!executable) {
    problems.push("CLIProxyAPI binary missing — run: cpa update");
  } else if (executable.kind === "backup") {
    problems.push(
      "only the backup binary is left after an interrupted update — run: cpa start or cpa update",
    );
  } else if (!installed.state.runtimeVersion) {
    problems.push("CLIProxyAPI version is not recorded — run: cpa update --force");
  }
  if (running && !reachable) {
    problems.push("CLIProxyAPI is not answering HTTP — check: cpa logs, or run: cpa restart");
  }
  if (!running) {
    // Autostart failures happen at login with no terminal; this record is their only trace.
    const last = readLastMiniCpaEvent(home);
    if (last?.level === "error") {
      const reason = last.message.replace(/^start failed: /, "");
      problems.push(`last start failed (${formatLocalTime(last.at)}): ${reason}`);
    }
  }
  return problems;
}

export type StatusDependencies = {
  inspectAutostartState?: () => Promise<AutostartState>;
};

export async function runStatus(cliVersion: string, deps?: StatusDependencies): Promise<void> {
  const ctx = createContext();
  // Read-only: an unlocked command must not repair (or race) the instance home.
  const running = await inspectRunning(ctx.home);
  const installed = inspectRuntimeInstallation(ctx.home);
  const initialized = fs.existsSync(ctx.layout.configFile);
  let autostart: AutostartState | undefined;
  try {
    autostart = await (deps?.inspectAutostartState ?? inspectAutostartState)();
  } catch (err) {
    const reason = err instanceof Error && err.message ? err.message : String(err);
    console.error(`Warning: could not inspect autostart: ${reason}`);
  }
  const reachable = running ? await waitForAnyHttpOk(readinessUrls(), 2000) : false;
  const version =
    installed.executable?.kind === "active" ? installed.state.runtimeVersion : undefined;

  printRow("Status", statusLine(running, initialized));
  printRow(
    "API",
    `${apiBaseUrl()}${running ? (reachable ? " (reachable)" : " (not reachable)") : ""}`,
  );
  printRow("Web", managementUrl());
  printRow("Autostart", autostart ? describeAutostartState(autostart) : "unknown");
  printRow("CLIProxyAPI", version ?? (installed.executable ? "unknown" : "not installed"));
  printRow("MiniCPA", cliVersion);
  printRow("Home", ctx.home);
  const route = describeDownloadRoute();
  if (route !== "Direct") printRow("Downloads", route);

  const problems = initialized ? detectProblems(ctx.home, installed, running, reachable) : [];
  if (problems.length > 0) console.log("");
  for (const problem of problems) console.log(`! ${problem}`);
  process.exitCode = running && reachable ? 0 : 1;
}

function missingBrowserCommand(err: unknown): string | undefined {
  const errno = err as NodeJS.ErrnoException;
  const message = typeof errno?.message === "string" ? errno.message : "";
  const match = /^spawn (.+) ENOENT$/.exec(message);
  if (match?.[1]) return match[1];
  if (errno?.code === "ENOENT") return errno.path || "browser launcher";
  return undefined;
}

function recordedProcessAlive(home: string): boolean {
  try {
    const record = readPidRecord(home);
    return record !== undefined && isProcessAlive(record.pid);
  } catch {
    return false;
  }
}

export async function runOpen(deps?: {
  openInBrowser?: (url: string) => Promise<void>;
}): Promise<void> {
  const ctx = createContext();
  const url = managementUrl();
  console.log(url);
  // PID liveness only: HTTP readiness stays with the browser, so web never waits.
  if (!recordedProcessAlive(ctx.home)) {
    console.error("Note: CLIProxyAPI is not running — run: cpa start");
  }
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
