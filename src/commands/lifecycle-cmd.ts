import fs from "node:fs";
import { openInBrowser } from "../browser.js";
import { readCpaConfigWithWarnings } from "../config-yaml.js";
import { createContext, printHome } from "../context.js";
import {
  apiBaseUrl,
  managementUrl,
  readinessUrls,
  waitForAnyHttpOk,
  waitForHttpOk,
} from "../process/health.js";
import { inspectRunning, startDaemon, stopDaemon } from "../process/lifecycle.js";
import { withMiniCpaLock } from "../process/lock.js";
import {
  inspectRunnableExecutable,
  readCurrentRuntimeVersion,
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

export async function runStatus(): Promise<void> {
  const ctx = createContext();
  // Read-only: an unlocked command must not repair (or race) the instance home.
  const running = inspectRunning(ctx.home);
  const version = await readCurrentRuntimeVersion(ctx.home);
  printHome(ctx);
  console.log(`Version    ${version ?? "(not installed)"}`);
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
}): Promise<void> {
  const ctx = createContext();
  const url = managementUrl(ctx.home);
  const ok = await waitForHttpOk(url, 3000);
  if (!ok) {
    // A binary-only install (`cpa update --binary`) serves the API but has no
    // management.html, so "run cpa start" would be a no-op remedy.
    const serverUp = await waitForAnyHttpOk(readinessUrls(ctx.home), 2000);
    if (serverUp) {
      throw new Error(
        "Web management panel is not installed (management.html is missing). Run: cpa update --panel",
      );
    }
    throw new Error(`CLIProxyAPI is not reachable at ${url}. Run: cpa start`);
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

/**
 * Read at most `maxBytes` from `pos`, reporting how far the cursor really moved.
 *
 * A log rotated between stat() and read() returns fewer bytes than requested, so
 * the cursor must advance by the bytes actually read (advancing by the requested
 * length skips real log content) and the buffer must be zero-filled and sliced
 * (an unread tail of an 8 MiB `allocUnsafe` buffer is raw heap memory).
 *
 * @internal exported for tests only
 */
export function readLogChunk(
  file: string,
  pos: number,
  maxBytes: number,
): { text: string; next: number } {
  const len = Math.max(0, maxBytes);
  if (len === 0) return { text: "", next: pos };
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, "r");
  let read: number;
  try {
    read = fs.readSync(fd, buf, 0, len, pos);
  } finally {
    fs.closeSync(fd);
  }
  // Nothing there any more: the file was rotated/truncated under us, so restart
  // from the top instead of stranding the cursor past the new end.
  if (read === 0) return { text: "", next: 0 };
  return { text: buf.subarray(0, read).toString(), next: pos + read };
}

/** @internal exported for tests only */
export async function tailFollowMany(files: string[]): Promise<void> {
  const state = new Map(files.map((f) => [f, fs.existsSync(f) ? fs.statSync(f).size : 0]));
  console.log(`Following ${files.join(" + ")} (Ctrl+C to exit)`);

  const interval = setInterval(() => {
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const stat = fs.statSync(file);
      let pos = state.get(file) ?? 0;
      if (stat.size < pos) pos = 0;
      if (stat.size > pos) {
        const { text, next } = readLogChunk(file, pos, Math.min(stat.size - pos, 8 * 1024 * 1024));
        state.set(file, next);
        if (!text) continue;
        const prefix = files.length > 1 ? `[${file.endsWith(".err.log") ? "err" : "out"}] ` : "";
        if (prefix) {
          for (const line of text.split(/\r?\n/)) {
            if (line.length) process.stdout.write(`${prefix + line}\n`);
          }
        } else {
          process.stdout.write(text);
        }
      }
    }
  }, 500);

  let onSigint: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      // process.exit() here would discard queued stdout writes (a piped stdout is
      // asynchronous on Windows); resolving lets Node drain and exit on its own.
      onSigint = (): void => {
        clearInterval(interval);
        process.exitCode = 130;
        resolve();
      };
      process.once("SIGINT", onSigint);
    });
  } finally {
    clearInterval(interval);
    if (onSigint) process.removeListener("SIGINT", onSigint);
  }
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
