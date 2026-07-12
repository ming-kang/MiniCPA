import fs from "node:fs";
import { defaultConfigYaml } from "../config-yaml.js";
import { createContext } from "../context.js";
import { ensureDir, miniCpaRoot, writeCliGlobalConfig } from "../paths.js";

export async function runInit(opts: { home?: string; force?: boolean }): Promise<void> {
  const ctx = createContext({ home: opts.home });
  const { layout, home } = ctx;

  ensureDir(home);
  ensureDir(layout.authsDir);
  ensureDir(layout.staticDir);
  ensureDir(layout.logsDir);
  ensureDir(layout.stateDir);
  ensureDir(layout.runtimeDir);

  if (!fs.existsSync(layout.configFile) || opts.force) {
    fs.writeFileSync(layout.configFile, defaultConfigYaml(), "utf8");
    console.log(`Created  ${layout.configFile}`);
  } else {
    console.log(`Exists   ${layout.configFile}`);
  }

  if (!fs.existsSync(layout.envFile)) {
    fs.writeFileSync(
      layout.envFile,
      "# Optional overrides for CPA (MANAGEMENT_PASSWORD, storage backends, etc.)\n",
      "utf8",
    );
  }

  writeCliGlobalConfig({ home });
  console.log(`MiniCPA root  ${miniCpaRoot()}`);
  console.log(`Instance      ${home}`);
  console.log(`Next: cpa update --all`);
  console.log(`      cpa start`);
  console.log(`      cpa open`);
}