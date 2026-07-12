import fs from "node:fs";
import { createContext, printHome } from "../context.js";
import { resolveRunning } from "../process/lifecycle.js";
import { readCurrentRuntimeVersion, resolveRunnableExecutable } from "../process/runtime.js";
import { waitForHttpOk, managementUrl } from "../process/health.js";

export async function runDoctor(opts: { home?: string }): Promise<void> {
  const ctx = createContext(opts);
  printHome(ctx);
  let ok = true;

  if (!fs.existsSync(ctx.layout.configFile)) {
    console.log("[fail] config.yaml missing — run: cpa init");
    ok = false;
  } else {
    console.log("[ ok ] config.yaml");
  }

  try {
    resolveRunnableExecutable(ctx.home);
    console.log("[ ok ] cli-proxy-api binary");
  } catch {
    console.log("[fail] cli-proxy-api missing — run: cpa update");
    ok = false;
  }

  const version = await readCurrentRuntimeVersion(ctx.home);
  console.log(`[info] cpa runtime ${version ?? "-"}`);

  const running = resolveRunning(ctx.home);
  if (running) {
    console.log(`[ ok ] running PID=${running.pid}`);
    const reachable = await waitForHttpOk(managementUrl(ctx.home), 2000);
    if (!reachable) {
      console.log("[fail] HTTP not reachable (check port in config.yaml)");
      ok = false;
    }
  } else {
    console.log("[info] not running (cpa start)");
  }

  process.exitCode = ok ? 0 : 1;
}