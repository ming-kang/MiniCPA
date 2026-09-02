import fs from "node:fs";
import { defaultConfigYaml, generateApiKey } from "../config-yaml.js";
import { createContext } from "../context.js";
import { writeFileAtomic } from "../fs-atomic.js";
import { withMiniCpaLock } from "../process/lock.js";
import { ensureDir, hardenCpaPermissions, miniCpaRoot } from "../paths.js";
import { performUpdate, type UpdateDeps } from "./update-cmd.js";

export async function runInit(opts: { force?: boolean }, updateDeps?: UpdateDeps): Promise<void> {
  const ctx = createContext();
  const { layout, home } = ctx;

  await withMiniCpaLock("init", async () => {
    ensureDir(home);
    ensureDir(layout.authsDir);
    ensureDir(layout.staticDir);
    ensureDir(layout.logsDir);
    ensureDir(layout.stateDir);

    if (!fs.existsSync(layout.configFile) || opts.force) {
      if (opts.force && fs.existsSync(layout.configFile)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const bak = `${layout.configFile}.bak.${stamp}`;
        fs.copyFileSync(layout.configFile, bak);
        if (process.platform !== "win32") fs.chmodSync(bak, 0o600);
        console.log(`Backed up ${layout.configFile} → ${bak}`);
      }
      const apiKey = generateApiKey();
      writeFileAtomic(layout.configFile, defaultConfigYaml(apiKey));
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

    hardenCpaPermissions(home);
    console.log(`MiniCPA root  ${miniCpaRoot()}`);
    console.log(`Home          ${home}`);
    console.log("Component     Ensuring latest CLIProxyAPI binary");

    await performUpdate(home, {}, updateDeps).finally(() => {
      // Also tighten files written by the install path, including partial installs.
      hardenCpaPermissions(home);
    });

    console.log("Next:");
    console.log("  cpa start");
    console.log("  cpa web");
  });
}
