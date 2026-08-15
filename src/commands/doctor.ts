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
  cliConfigPath,
  miniCpaTempRoot,
  unlockProbePath,
} from "../paths.js";
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
    console.log("[fail] CPA home missing — run: cpa init");
    return false;
  }

  if (process.platform === "win32") {
    const probe = path.join(home, WRITE_PROBE_NAME);
    try {
      writeFileAtomic(probe, "");
      console.log("[ ok ] CPA home writable");
      return true;
    } catch {
      console.log("[fail] CPA home not writable");
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
    console.log("[ ok ] CPA home writable");
    return true;
  } catch {
    console.log("[fail] CPA home not writable");
    return false;
  }
}

export type DoctorDeps = {
  checkGithubReachability?: () => Promise<GithubReachability>;
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
      if (apiKeys.includes(LEGACY_DEFAULT_API_KEY)) {
        console.log(
          `[warn] default api-key ${LEGACY_DEFAULT_API_KEY} still in config — change before exposing the API`,
        );
      }
      if (
        host !== "127.0.0.1" &&
        host !== "localhost" &&
        apiKeys.includes(LEGACY_DEFAULT_API_KEY)
      ) {
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
    console.log("[fail] cli-proxy-api missing — run: cpa update");
    ok = false;
  } else if (exe === activeExe) {
    console.log(`[ ok ] binary ${exe}`);
  } else {
    console.log(`[warn] active binary missing; only ${exe} present — run: cpa start or cpa update`);
  }

  const version = await readCurrentRuntimeVersion(ctx.home);
  const state = readInstallState(ctx.home);
  console.log(`[info] cpa runtime ${version ?? "-"} (state=${state.runtimeVersion ?? "-"})`);
  if (exe === activeExe && !version) {
    console.log(
      "[warn] binary present but not runnable (version probe failed) — run: cpa update --force",
    );
  }
  if (state.runtimeVersion && !version) {
    console.log("[warn] install state has runtimeVersion but binary is missing/unprobeable");
  } else if (state.runtimeVersion && version && state.runtimeVersion !== version) {
    console.log("[warn] runtime version differs from install state — run: cpa update --force");
  }
  console.log(`[info] panel ${state.panelVersion ?? "(not installed)"}`);

  if (fs.existsSync(ctx.layout.managementHtml)) {
    console.log(`[ ok ] management.html`);
  } else {
    console.log("[warn] management.html missing — run: cpa update --panel (or default update)");
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

  const globalCfg = cliConfigPath();
  if (fs.existsSync(globalCfg)) {
    try {
      JSON.parse(fs.readFileSync(globalCfg, "utf8"));
    } catch {
      console.log(`[warn] MiniCPA config.json is corrupt (${globalCfg})`);
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
      `[warn] binary backup present (${bak}) — kept after incomplete update; cleared after healthy restart`,
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
      console.log(`[warn] running PID=${running.pid} (identity probe inconclusive — not cleared)`);
    } else {
      console.log(`[ ok ] running PID=${running.pid}`);
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
    console.log("[info] not running (cpa start)");
  }

  if (hasProxyEnvConfigured()) {
    console.log(`[info] proxy env ${describeProxyEnv()}`);
  } else {
    console.log("[info] proxy env none (HTTP(S)_PROXY / ALL_PROXY not set)");
  }

  // Optional: GitHub reachability (non-fatal). Uses the update client's headers,
  // so a configured GITHUB_TOKEN/GH_TOKEN reports the quota MiniCPA really gets.
  const probeGithub =
    deps?.checkGithubReachability ?? ((): Promise<GithubReachability> => checkGithubReachability());
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
