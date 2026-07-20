import fs from "node:fs";
import { getListenAddress, LEGACY_DEFAULT_API_KEY, readCpaConfig } from "../config-yaml.js";
import { createContext, printHome } from "../context.js";
import { describeProxyEnv, hasProxyEnvConfigured, httpFetch } from "../http.js";
import { activeExecutablePath, backupExecutablePath, cliConfigPath, miniCpaTempRoot } from "../paths.js";
import { readinessUrls, waitForAnyHttpOk } from "../process/health.js";
import { resolveRunning } from "../process/lifecycle.js";
import { readCurrentRuntimeVersion, resolveRunnableExecutable } from "../process/runtime.js";
import { readInstallState } from "../state.js";
import {
  DEFAULT_LOG_ROTATE_BYTES,
  directorySizeBytes,
  formatBytes,
} from "../util.js";

export async function runDoctor(opts: { home?: string }): Promise<void> {
  const ctx = createContext(opts);
  printHome(ctx);
  let ok = true;

  // Layout / write access
  try {
    fs.accessSync(ctx.home, fs.constants.W_OK);
    console.log("[ ok ] CPA_HOME writable");
  } catch {
    if (!fs.existsSync(ctx.home)) {
      console.log("[fail] CPA_HOME missing — run: cpa init");
    } else {
      console.log("[fail] CPA_HOME not writable");
    }
    ok = false;
  }

  if (!fs.existsSync(ctx.layout.configFile)) {
    console.log("[fail] config.yaml missing — run: cpa init");
    ok = false;
  } else {
    try {
      const cfg = readCpaConfig(ctx.layout.configFile);
      const { host, port } = getListenAddress(cfg);
      console.log("[ ok ] config.yaml");
      console.log(`[info] listen ${host}:${port}`);
      const apiKeys = cfg["api-keys"] ?? [];
      if (apiKeys.includes(LEGACY_DEFAULT_API_KEY)) {
        console.log(
          `[warn] default api-key ${LEGACY_DEFAULT_API_KEY} still in config — change before exposing the API`,
        );
      }
      if (host !== "127.0.0.1" && host !== "localhost" && apiKeys.includes(LEGACY_DEFAULT_API_KEY)) {
        console.log("[warn] non-loopback host with legacy default api-key is unsafe");
      }
    } catch (err) {
      console.log(`[fail] config.yaml parse error: ${(err as Error).message}`);
      ok = false;
    }
  }

  try {
    const exe = resolveRunnableExecutable(ctx.home);
    console.log(`[ ok ] binary ${exe}`);
  } catch {
    console.log("[fail] cli-proxy-api missing — run: cpa update");
    ok = false;
  }

  const version = await readCurrentRuntimeVersion(ctx.home);
  const state = readInstallState(ctx.home);
  console.log(`[info] cpa runtime ${version ?? "-"} (state=${state.runtimeVersion ?? "-"})`);
  if (state.runtimeVersion && !version) {
    console.log("[warn] install state has runtimeVersion but binary is missing/unprobeable");
  } else if (state.runtimeVersion && version && state.runtimeVersion !== version) {
    console.log("[warn] runtime version differs from install state (will sync on next probe write)");
  }
  console.log(`[info] panel ${state.panelVersion ?? "-"}`);

  if (fs.existsSync(ctx.layout.managementHtml)) {
    console.log(`[ ok ] management.html`);
  } else {
    console.log("[warn] management.html missing — run: cpa update --panel (or default update)");
  }

  for (const dir of [ctx.layout.logsDir, ctx.layout.stateDir, ctx.layout.authsDir, ctx.layout.staticDir]) {
    if (!fs.existsSync(dir)) {
      console.log(`[warn] dir missing: ${dir}`);
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

  const unlockProbe = `${activeExecutablePath(ctx.home)}.unlock-probe`;
  if (fs.existsSync(unlockProbe)) {
    console.log(
      `[warn] unlock-probe residue present (${unlockProbe}) — run cpa start to recover or rename to the active binary`,
    );
  }

  const tempRoot = miniCpaTempRoot();
  const tempSize = directorySizeBytes(tempRoot);
  if (tempSize > 10 * 1024 * 1024) {
    console.log(
      `[warn] temp ${formatBytes(tempSize)} under ${tempRoot} — run: cpa clean`,
    );
  } else if (tempSize > 0) {
    console.log(`[info] temp ${formatBytes(tempSize)} (${tempRoot})`);
  } else {
    console.log(`[info] temp empty (${tempRoot})`);
  }

  const running = resolveRunning(ctx.home);
  if (running) {
    if (running.identityUnknown) {
      console.log(`[warn] running PID=${running.pid} (identity probe inconclusive — not cleared)`);
    } else {
      console.log(`[ ok ] running PID=${running.pid}`);
    }
    const urls = readinessUrls(ctx.home);
    const reachable = await waitForAnyHttpOk(urls, 3000);
    if (!reachable) {
      console.log(`[fail] HTTP not reachable (tried ${urls.join(", ")})`);
      ok = false;
    } else {
      console.log(`[ ok ] HTTP ${urls[0]}`);
    }
  } else {
    console.log("[info] not running (cpa start)");
  }

  if (hasProxyEnvConfigured()) {
    console.log(`[info] proxy env ${describeProxyEnv()}`);
  } else {
    console.log("[info] proxy env none (HTTP(S)_PROXY / ALL_PROXY not set)");
  }

  // Optional: GitHub reachability (non-fatal)
  try {
    const res = await httpFetch(
      "https://api.github.com/rate_limit",
      {
        headers: { "User-Agent": "MiniCPA", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(10_000),
      },
      { retries: 1, minDelayMs: 200, maxDelayMs: 1_000 },
    );
    if (res.ok) {
      const body = (await res.json()) as { resources?: { core?: { remaining?: number } } };
      const remaining = body.resources?.core?.remaining;
      console.log(
        `[ ok ] GitHub API${remaining !== undefined ? ` (rate remaining=${remaining})` : ""}`,
      );
      if (remaining !== undefined && remaining < 5) {
        console.log(
          "[info] REST rate low (updates use github.com/releases by default; " +
            "GITHUB_TOKEN/GH_TOKEN only needed for API fallback)",
        );
      }
    } else {
      console.log(`[warn] GitHub API HTTP ${res.status}`);
    }
  } catch (err) {
    console.log(`[warn] GitHub unreachable: ${(err as Error).message}`);
  }

  process.exitCode = ok ? 0 : 1;
}
