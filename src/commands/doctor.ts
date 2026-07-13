import fs from "node:fs";
import { getListenAddress, readCpaConfig } from "../config-yaml.js";
import { createContext, printHome } from "../context.js";
import { describeProxyEnv, hasProxyEnvConfigured, httpFetch } from "../http.js";
import { managementUrl, waitForHttpOk } from "../process/health.js";
import { resolveRunning } from "../process/lifecycle.js";
import { readCurrentRuntimeVersion, resolveRunnableExecutable } from "../process/runtime.js";
import { readInstallState } from "../state.js";

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
    console.log("[ ok ] config.yaml");
    try {
      const cfg = readCpaConfig(ctx.layout.configFile);
      const { host, port } = getListenAddress(cfg);
      console.log(`[info] listen ${host}:${port}`);
      const apiKeys = cfg["api-keys"] ?? [];
      if (apiKeys.includes("sk-cliproxyapi")) {
        console.log(
          "[warn] default api-key sk-cliproxyapi still in config — change before exposing the API",
        );
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

  const running = resolveRunning(ctx.home);
  if (running) {
    console.log(`[ ok ] running PID=${running.pid}`);
    const url = managementUrl(ctx.home);
    const reachable = await waitForHttpOk(url, 3000);
    if (!reachable) {
      console.log(`[fail] HTTP not reachable at ${url}`);
      ok = false;
    } else {
      console.log(`[ ok ] HTTP ${url}`);
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
    const res = await httpFetch("https://api.github.com/rate_limit", {
      headers: { "User-Agent": "MiniCPA", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { resources?: { core?: { remaining?: number } } };
      const remaining = body.resources?.core?.remaining;
      console.log(
        `[ ok ] GitHub API${remaining !== undefined ? ` (rate remaining=${remaining})` : ""}`,
      );
      if (remaining !== undefined && remaining < 5) {
        console.log("[warn] GitHub rate limit low — set GITHUB_TOKEN for updates");
      }
    } else {
      console.log(`[warn] GitHub API HTTP ${res.status}`);
    }
  } catch (err) {
    console.log(`[warn] GitHub unreachable: ${(err as Error).message}`);
  }

  process.exitCode = ok ? 0 : 1;
}
