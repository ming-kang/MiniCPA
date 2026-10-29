import fs from "node:fs";
import { backupConfigYaml } from "../config-backup.js";
import { defaultConfigYaml, generateApiKey } from "../config-yaml.js";
import { createContext } from "../context.js";
import { writeFileAtomic } from "../fs-atomic.js";
import { ensureDir, hardenCpaPermissions, miniCpaRoot } from "../paths.js";
import { withMiniCpaLock, withMiniCpaUpdateLock } from "../process/lock.js";
import { performUpdate, type UpdateDeps } from "./update-cmd.js";

export async function runInit(opts: { force?: boolean }, updateDeps?: UpdateDeps): Promise<void> {
  const ctx = createContext();
  const { layout, home } = ctx;
  await withMiniCpaUpdateLock("init", async () => {
    await withMiniCpaLock("init", async () => {
      ensureDir(home);
      for (const dir of [layout.authsDir, layout.staticDir, layout.logsDir, layout.stateDir])
        ensureDir(dir);
      if (!fs.existsSync(layout.configFile) || opts.force) {
        if (opts.force && fs.existsSync(layout.configFile)) {
          const backup = backupConfigYaml(layout.configFile);
          console.log(`Backed up ${layout.configFile} → ${backup}`);
        }
        writeFileAtomic(layout.configFile, defaultConfigYaml(generateApiKey()));
        console.log(`Created    ${layout.configFile}`);
        console.log("API key    Created in config.yaml (not shown)");
      } else {
        console.log(`Exists     ${layout.configFile}`);
      }
      if (!fs.existsSync(layout.envFile)) {
        writeFileAtomic(
          layout.envFile,
          "# Optional overrides for CLIProxyAPI (MANAGEMENT_PASSWORD, storage backends, etc.)\n",
        );
      }
      // Deep permission repair is explicit initialization work, never a startup scan.
      hardenCpaPermissions(home, { deep: true });
    });
    console.log(`MiniCPA root  ${miniCpaRoot()}`);
    console.log(`Home          ${home}`);
    console.log("Component     Ensuring latest CLIProxyAPI binary");
    // Configuration survives download failures; start/stop are free during preparation.
    await performUpdate(home, {}, updateDeps);
    console.log("Next:");
    console.log("  cpa start");
    console.log("  cpa web");
  });
}
