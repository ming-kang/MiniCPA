import fs from "node:fs";
import path from "node:path";
import { formatCliError } from "../cli-errors.js";
import {
  getListenAddress,
  LEGACY_DEFAULT_API_KEY,
  readCpaConfigWithWarnings,
} from "../config-yaml.js";
import { createContext, printHome } from "../context.js";
import { writeFileAtomic } from "../fs-atomic.js";
import { describeProxyEnv, hasProxyEnvConfigured } from "../http.js";
import {
  activeExecutablePath,
  backupExecutablePath,
  miniCpaTempRoot,
  unlockProbePath,
} from "../paths.js";
import { inspectAutostartState, lingerHint, type AutostartState } from "../process/autostart.js";
import { readinessUrls, waitForAnyHttpOk } from "../process/health.js";
import { inspectRunning } from "../process/lifecycle.js";
import { inspectMiniCpaLock, listLockPreemptResidue } from "../process/lock.js";
import { findRunnableExecutable, readCurrentRuntimeVersion } from "../process/runtime.js";
import { readInstallState } from "../state.js";
import { checkGithubReachability, type GithubReachability } from "../update/github-client.js";
import { DEFAULT_LOG_ROTATE_BYTES, directorySizeBytes, formatBytes } from "../util.js";

/** Transient file used to prove the home is writable on Windows. */
const WRITE_PROBE_NAME = ".minicpa-write-probe";

/**
 * Report whether the instance home can actually be written to.
 *
 * `fs.access(W_OK)` only consults FILE_ATTRIBUTE_READONLY on Windows and ignores
 * the ACL, so it reports success for exactly the directory this check exists to
 * catch. Windows therefore gets a real write probe instead.
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

/**
 * Report the autostart registration. Never fails the report: "off" is a valid
 * choice, and a broken registration is a warning a user can repair with
 * `cpa auto` — not something that should turn the diagnostics red.
 */
async function reportAutostart(deps: DoctorDeps): Promise<void> {
  const inspect = deps.inspectAutostartState ?? inspectAutostartState;
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
  // lingerHint owns the Linux gating and resolves even when its probe fails.
  const hint = await (deps.lingerHint ?? lingerHint)();
  if (hint) console.log(`[info] ${hint}`);
}

export type DoctorDeps = {
  checkGithubReachability?: () => Promise<GithubReachability>;
  inspectAutostartState?: () => Promise<AutostartState>;
  lingerHint?: typeof lingerHint;
};

export async function runDoctor(deps?: DoctorDeps): Promise<void> {
  const ctx = createContext();
  printHome(ctx);
  let ok = true;

  // Layout / write access
  if (!reportHomeWritable(ctx.home)) {
    ok = false;
  }

  if (!fs.existsSync(ctx.layout.configFile)) {
    console.log("[fail] config.yaml missing — run: cpa init");
    ok = false;
  } else {
    try {
      const { config: cfg, warnings } = readCpaConfigWithWarnings(ctx.layout.configFile);
      const { host, port } = getListenAddress(cfg);
      console.log("[ ok ] config.yaml");
      for (const warning of warnings) {
        console.log(`[warn] ${warning}`);
      }
      console.log(`[info] listen ${host}:${port}`);
      const apiKeys = cfg["api-keys"] ?? [];
      const hasLegacyApiKey = apiKeys.includes(LEGACY_DEFAULT_API_KEY);
      if (hasLegacyApiKey) {
        console.log(
          `[warn] default api-key ${LEGACY_DEFAULT_API_KEY} still in config — change before exposing the API`,
        );
      }
      if (host !== "127.0.0.1" && host !== "localhost" && hasLegacyApiKey) {
        console.log("[warn] non-loopback host with legacy default api-key is unsafe");
      }
    } catch (err) {
      console.log(`[fail] config.yaml parse error: ${formatCliError(err)}`);
      ok = false;
    }
  }

  // Read-only lookup: diagnosing the home must never repair it, or doctor would
  // report on residue it created itself two lines earlier.
  const exe = findRunnableExecutable(ctx.home);
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

  const version = await readCurrentRuntimeVersion(ctx.home);
  const state = readInstallState(ctx.home);
  console.log(
    `[info] CLIProxyAPI version ${version ?? "-"} (state=${state.runtimeVersion ?? "-"})`,
  );
  if (exe === activeExe && !version) {
    console.log(
      "[warn] CLIProxyAPI binary is present but not runnable (version probe failed) — run: cpa update --force",
    );
  }
  if (state.runtimeVersion && !version) {
    console.log("[warn] install state has runtimeVersion but binary is missing/unprobeable");
  } else if (state.runtimeVersion && state.runtimeVersion !== version) {
    console.log("[warn] runtime version differs from install state — run: cpa update --force");
  }
  console.log(`[info] Web panel ${state.panelVersion ?? "(not installed)"}`);

  if (fs.existsSync(ctx.layout.managementHtml)) {
    console.log("[ ok ] Web panel (management.html)");
  } else {
    console.log("[warn] Web panel missing — run: cpa update --panel (or cpa update)");
  }

  for (const dir of [
    ctx.layout.logsDir,
    ctx.layout.stateDir,
    ctx.layout.authsDir,
    ctx.layout.staticDir,
  ]) {
    if (!fs.existsSync(dir)) {
      console.log(`[warn] dir missing: ${dir}`);
    }
  }

  if (process.platform !== "win32") {
    for (const target of [
      ctx.home,
      ctx.layout.configFile,
      ctx.layout.envFile,
      ctx.layout.authsDir,
      ctx.layout.logsDir,
      ctx.layout.stateDir,
      ctx.layout.installStateFile,
      ctx.layout.pidFile,
      ctx.layout.logFile,
      ctx.layout.errLogFile,
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
      if (size >= DEFAULT_LOG_ROTATE_BYTES) {
        console.log(
          `[warn] ${label} is ${formatBytes(size)} — will rotate on next cpa start (≥ ${formatBytes(DEFAULT_LOG_ROTATE_BYTES)})`,
        );
      } else if (size > 0) {
        console.log(`[info] ${label} ${formatBytes(size)}`);
      }
    } catch {
      /* ignore */
    }
  }

  const bak = backupExecutablePath(ctx.home);
  if (fs.existsSync(bak)) {
    console.log(
      `[warn] CLIProxyAPI binary backup present (${bak}) — kept after incomplete update; cleared after healthy restart`,
    );
  }

  const unlockProbe = unlockProbePath(ctx.home);
  if (fs.existsSync(unlockProbe)) {
    console.log(
      `[warn] unlock-probe residue present (${unlockProbe}) — run cpa start to recover or rename to the active binary`,
    );
  }

  try {
    for (const entry of fs.readdirSync(ctx.layout.stateDir)) {
      if (entry.endsWith(".replace.bak")) {
        console.log(
          `[warn] atomic-write backup residue in state dir (${entry}) — recovered automatically on next write`,
        );
      }
    }
  } catch {
    /* state dir may not exist yet */
  }

  const tempRoot = miniCpaTempRoot();
  const tempSize = directorySizeBytes(tempRoot);
  if (tempSize > 10 * 1024 * 1024) {
    console.log(`[warn] temp ${formatBytes(tempSize)} under ${tempRoot} — run: cpa clean`);
  } else if (tempSize > 0) {
    console.log(`[info] temp ${formatBytes(tempSize)} (${tempRoot})`);
  } else {
    console.log(`[info] temp empty (${tempRoot})`);
  }

  // A held lock is normal while another command runs, so it never fails the
  // report — but it is the only way a user can see what is blocking them.
  const lock = inspectMiniCpaLock();
  if (lock.state === "held") {
    const holderGone =
      lock.holderAlive === false ? " (holder process is NOT alive — safe to delete this file)" : "";
    console.log(
      `[warn] MiniCPA lock held by PID=${lock.pid} (cpa ${lock.command}) since ` +
        `${lock.acquiredAt || "unknown"} — ${lock.path}${holderGone}`,
    );
  } else if (lock.state === "unreadable") {
    console.log(`[warn] MiniCPA lock file unreadable: ${lock.path}`);
  }
  for (const residue of listLockPreemptResidue()) {
    console.log(
      `[warn] lock preempt residue (${residue}) — safe to delete when no cpa command is running`,
    );
  }

  const running = inspectRunning(ctx.home);
  if (running) {
    if (running.identityUnknown) {
      console.log(
        `[warn] CLIProxyAPI running (PID=${running.pid}; identity probe inconclusive — not cleared)`,
      );
    } else {
      console.log(`[ ok ] CLIProxyAPI running (PID=${running.pid})`);
    }
    try {
      const urls = readinessUrls(ctx.home);
      const reachable = await waitForAnyHttpOk(urls, 3000);
      if (!reachable) {
        console.log(`[fail] HTTP not reachable (tried ${urls.join(", ")})`);
        ok = false;
      } else {
        console.log(`[ ok ] HTTP ${urls[0]}`);
      }
    } catch (err) {
      // A broken config.yaml is already reported above; re-throwing it here would
      // drop the remaining sections of the report.
      console.log(`[fail] cannot derive listen address: ${formatCliError(err)}`);
      ok = false;
    }
  } else {
    console.log("[info] CLIProxyAPI is not running (cpa start)");
  }

  await reportAutostart(deps ?? {});

  if (hasProxyEnvConfigured()) {
    console.log(`[info] proxy env ${describeProxyEnv()}`);
  } else {
    console.log("[info] proxy env none (HTTP(S)_PROXY / ALL_PROXY not set)");
  }

  // Optional: GitHub reachability (non-fatal). Uses the update client's headers,
  // so a configured GITHUB_TOKEN/GH_TOKEN reports the quota MiniCPA really gets.
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
          "[info] REST rate low (updates use github.com/releases by default; " +
            "GITHUB_TOKEN/GH_TOKEN only needed for API fallback)",
        );
      }
    } else {
      const rateLimited = reach.status === 403 || reach.status === 429;
      console.log(
        `[warn] GitHub API HTTP ${reach.status}` +
          (rateLimited
            ? " (rate limited — set GITHUB_TOKEN/GH_TOKEN; panel updates always need the API)"
            : ""),
      );
    }
  } catch (err) {
    console.log(`[warn] GitHub unreachable: ${formatCliError(err)}`);
  }

  process.exitCode = ok ? 0 : 1;
}
