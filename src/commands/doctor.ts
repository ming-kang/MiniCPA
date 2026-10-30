import { lingerHint } from "../process/autostart-linux.js";
import fs from "node:fs";
import path from "node:path";
import { formatCliError } from "../cli-errors.js";
import { createContext, printHome } from "../context.js";
import { writeFileAtomic } from "../fs-atomic.js";
import { describeProxyEnv, hasProxyEnvConfigured } from "../http.js";
import { readLastMiniCpaEvent, type MiniCpaEvent } from "../minicpa-log.js";
import { activeExecutablePath, backupExecutablePath, miniCpaTempRoot } from "../paths.js";
import { inspectAutostartState, type AutostartState } from "../process/autostart.js";
import { readinessUrls, waitForFirstHttpOk } from "../process/health.js";
import { inspectRunning } from "../process/lifecycle.js";
import { inspectMiniCpaLock } from "../process/lock.js";
import { inspectRuntimeInstallation } from "../process/runtime.js";
import { checkGithubReachability, type GithubReachability } from "../update/github-client.js";
import { runtimeLogDirectory, runtimeLogFile } from "../runtime-logs.js";
import { directorySizeBytes, formatBytes } from "../util.js";

const WRITE_PROBE_NAME = ".minicpa-write-probe";

/**
 * fs.access(W_OK) only consults FILE_ATTRIBUTE_READONLY on Windows and ignores
 * the ACL, so Windows requires a real write probe.
 */
function reportHomeWritable(home: string): boolean {
  if (!fs.existsSync(home)) {
    console.log("[fail] instance directory missing — run: cpa init");
    return false;
  }

  if (process.platform === "win32") {
    const probe = path.join(home, WRITE_PROBE_NAME);
    try {
      writeFileAtomic(probe, "");
      console.log("[ ok ] instance directory writable");
      return true;
    } catch {
      console.log("[fail] instance directory not writable");
      return false;
    } finally {
      try {
        fs.unlinkSync(probe);
      } catch {
        /* the probe may never have been created */
      }
    }
  }

  try {
    fs.accessSync(home, fs.constants.W_OK);
    console.log("[ ok ] instance directory writable");
    return true;
  } catch {
    console.log("[fail] instance directory not writable");
    return false;
  }
}

async function reportAutostart(
  inspect: () => Promise<AutostartState>,
  hint: () => Promise<string | undefined>,
  lastStartEvent: () => MiniCpaEvent | undefined,
  startLogFile: string,
): Promise<void> {
  let state: AutostartState;
  try {
    state = await inspect();
  } catch (err) {
    console.log(`[warn] cannot inspect autostart: ${formatCliError(err)}`);
    return;
  }
  switch (state) {
    case "on":
      console.log("[ ok ] autostart on");
      break;
    case "off":
      console.log("[info] autostart off (cpa auto on)");
      break;
    case "stale":
      console.log("[warn] autostart registration targets a different launcher — run: cpa auto");
      break;
    case "disabled":
      console.log("[warn] autostart registration disabled by the OS — run: cpa auto");
      break;
  }
  if (state !== "on") return;
  const line = await hint();
  if (line) console.log(`[info] ${line}`);
  reportLastStartFailure(lastStartEvent, startLogFile);
}

function reportLastStartFailure(
  lastStartEvent: () => MiniCpaEvent | undefined,
  startLogFile: string,
): void {
  const event = lastStartEvent();
  if (event?.level !== "error") return;
  console.log(`[warn] ${event.message} (${event.at})`);
  console.log(`[info] MiniCPA start log ${startLogFile}`);
}

export type DoctorDeps = {
  checkGithubReachability?: () => Promise<GithubReachability>;
  inspectAutostartState?: () => Promise<AutostartState>;
  lingerHint?: typeof lingerHint;
  lastStartEvent?: () => MiniCpaEvent | undefined;
};

export async function runDoctor(deps?: DoctorDeps, options?: { deep?: boolean }): Promise<void> {
  const ctx = createContext();
  printHome(ctx);
  let ok = true;

  if (!reportHomeWritable(ctx.home)) {
    ok = false;
  }

  if (!fs.existsSync(ctx.layout.configFile)) {
    console.log("[fail] config.yaml missing — run: cpa init");
    ok = false;
  } else {
    console.log("[ ok ] config.yaml present (contents managed by CLIProxyAPI)");
  }
  console.log("[info] Web panel managed by CLIProxyAPI");

  // Read-only inspection: must never repair or execute binary to avoid racing updates.
  const installed = inspectRuntimeInstallation(ctx.home);
  const exe = installed.executable?.path;
  const activeExe = activeExecutablePath(ctx.home);
  if (exe === undefined) {
    console.log("[fail] CLIProxyAPI binary missing — run: cpa update");
    ok = false;
  } else if (exe === activeExe) {
    console.log(`[ ok ] CLIProxyAPI binary ${exe}`);
  } else {
    console.log(
      `[warn] active CLIProxyAPI binary missing; only ${exe} is present — run: cpa start or cpa update`,
    );
  }

  const state = installed.state;
  console.log(`[info] CLIProxyAPI recorded version ${state.runtimeVersion ?? "-"}`);
  if (exe === activeExe && !state.runtimeVersion) {
    console.log(
      "[warn] CLIProxyAPI binary is present but its version is not recorded — run: cpa update --force",
    );
  }
  if (state.runtimeVersion && exe === undefined) {
    console.log("[warn] install state has runtimeVersion but binary is missing");
  }
  if (!fs.existsSync(ctx.layout.stateDir)) {
    console.log(`[warn] dir missing: ${ctx.layout.stateDir}`);
  }

  if (process.platform !== "win32") {
    for (const target of [
      ctx.home,
      ctx.layout.stateDir,
      ctx.layout.installStateFile,
      ctx.layout.pidFile,
      ctx.layout.logFile,
      ctx.layout.errLogFile,
      ctx.layout.minicpaLogFile,
    ]) {
      if (!fs.existsSync(target)) continue;
      try {
        const mode = fs.statSync(target).mode & 0o777;
        if ((mode & 0o077) !== 0) {
          console.log(
            `[warn] permissions ${mode.toString(8).padStart(3, "0")} expose private data: ${target}`,
          );
        }
      } catch {
        /* best-effort diagnostic */
      }
    }
  }

  for (const [label, file] of [
    ["cpa.log", ctx.layout.logFile],
    ["cpa.err.log", ctx.layout.errLogFile],
  ] as const) {
    if (!fs.existsSync(file)) continue;
    try {
      const size = fs.statSync(file).size;
      if (size > 0) {
        console.log(
          `[info] legacy ${label} ${formatBytes(size)} — read with cpa logs --legacy; new starts do not append here`,
        );
      }
    } catch {
      /* ignore */
    }
  }

  console.log(
    `[info] CLIProxyAPI native logs ${runtimeLogDirectory(ctx.home)} (rotation owned by CLIProxyAPI)`,
  );
  try {
    if (fs.existsSync(runtimeLogFile(ctx.home))) {
      console.log(`[info] main.log ${formatBytes(fs.statSync(runtimeLogFile(ctx.home)).size)}`);
    }
  } catch {
    /* best-effort native log diagnostic */
  }

  const bak = backupExecutablePath(ctx.home);
  if (fs.existsSync(bak)) {
    console.log(
      `[warn] CLIProxyAPI binary backup present (${bak}) — kept after incomplete update; cleared after healthy restart`,
    );
  }

  const tempRoot = miniCpaTempRoot();
  if (options?.deep) {
    const tempSize = directorySizeBytes(tempRoot);
    const label = tempSize > 10 * 1024 * 1024 ? "warn" : "info";
    console.log(`[${label}] temp ${formatBytes(tempSize)} under ${tempRoot} — run: cpa clean`);
  } else {
    console.log(
      fs.existsSync(tempRoot)
        ? `[info] temp ${tempRoot} (size not scanned; use cpa doctor --deep or cpa clean)`
        : `[info] temp empty (${tempRoot})`,
    );
  }

  for (const [scope, label] of [
    ["lifecycle", "MiniCPA"],
    ["update", "Update preparation"],
  ] as const) {
    const lock = inspectMiniCpaLock(scope);
    if (lock.state === "record") {
      const processNote = lock.holderAlive ? "" : " (recorded process exited)";
      console.log(
        `[info] ${label} lock record PID=${lock.pid} (cpa ${lock.command}) since ${lock.acquiredAt} — ${lock.path}${processNote}`,
      );
    } else if (lock.state === "unreadable") {
      console.log(`[warn] ${label} lock record unreadable: ${lock.path}`);
    }
  }

  const running = await inspectRunning(ctx.home);
  if (running) {
    if (running.identityUnknown) {
      console.log(
        `[warn] CLIProxyAPI running (PID=${running.pid}; identity probe inconclusive — not cleared)`,
      );
    } else {
      console.log(`[ ok ] CLIProxyAPI running (PID=${running.pid})`);
    }
    try {
      const urls = readinessUrls();
      const reachableUrl = await waitForFirstHttpOk(urls, 3000);
      if (!reachableUrl) {
        console.log(`[fail] HTTP not reachable (tried ${urls.join(", ")})`);
        ok = false;
      } else {
        console.log(`[ ok ] HTTP ${reachableUrl}`);
      }
    } catch (error) {
      console.log(`[fail] CPA API probe failed: ${formatCliError(error)}`);
      ok = false;
    }
  } else {
    console.log("[info] CLIProxyAPI is not running (cpa start)");
  }

  await reportAutostart(
    deps?.inspectAutostartState ?? inspectAutostartState,
    deps?.lingerHint ?? lingerHint,
    deps?.lastStartEvent ?? (() => readLastMiniCpaEvent(ctx.home)),
    ctx.layout.minicpaLogFile,
  );

  if (hasProxyEnvConfigured()) {
    console.log(`[info] proxy env ${describeProxyEnv()}`);
  } else {
    console.log("[info] proxy env none (HTTP(S)_PROXY / ALL_PROXY not set)");
  }

  const probeGithub = deps?.checkGithubReachability ?? checkGithubReachability;
  try {
    const reach = await probeGithub();
    if (reach.ok) {
      const identity = reach.authenticated ? "authenticated" : "anonymous";
      const detail =
        reach.remaining !== undefined
          ? ` (rate remaining=${reach.remaining}, ${identity})`
          : ` (${identity})`;
      console.log(`[ ok ] GitHub API${detail}`);
      if (reach.remaining !== undefined && reach.remaining < 5) {
        console.log(
          "[info] REST rate low (binary updates use github.com/releases by default; " +
            "GITHUB_TOKEN/GH_TOKEN only needed for API fallback)",
        );
      }
    } else {
      const rateLimited = reach.status === 403 || reach.status === 429;
      console.log(
        `[warn] GitHub API HTTP ${reach.status}` +
          (rateLimited ? " (rate limited — set GITHUB_TOKEN/GH_TOKEN and retry)" : ""),
      );
    }
  } catch (err) {
    console.log(`[warn] GitHub unreachable: ${formatCliError(err)}`);
  }

  process.exitCode = ok ? 0 : 1;
}
