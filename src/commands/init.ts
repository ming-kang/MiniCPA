import fs from "node:fs";
import { defaultConfigYaml, generateApiKey } from "../config-yaml.js";
import { createContext } from "../context.js";
import { writeFileAtomic } from "../fs-atomic.js";
import { withMiniCpaLock } from "../process/lock.js";
import { ensureDir, hardenCpaPermissions, miniCpaRoot, writeCliGlobalConfig } from "../paths.js";

export async function runInit(opts: { force?: boolean }): Promise<void> {
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
      console.log(`Created  ${layout.configFile}`);
      console.log("api-key  created in config.yaml (not printed to protect it)");
    } else {
      console.log(`Exists   ${layout.configFile}`);
    }

    if (!fs.existsSync(layout.envFile)) {
      writeFileAtomic(
        layout.envFile,
        "# Optional overrides for CPA (MANAGEMENT_PASSWORD, storage backends, etc.)\n",
      );
    }

    // Preserve future keys in global config by merging.
    writeCliGlobalConfig({ home });
    hardenCpaPermissions(home);
    console.log(`MiniCPA root  ${miniCpaRoot()}`);
    console.log(`Instance      ${home}`);
    console.log(`Next: cpa update`);
    console.log(`      cpa start`);
    console.log(`      cpa open`);
  });
}
