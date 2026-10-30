import fs from "node:fs";
import { apiBaseUrl } from "../api-url.js";
import { createContext } from "../context.js";
import { ensureDir, miniCpaRoot } from "../paths.js";
import { withMiniCpaLock, withMiniCpaUpdateLock } from "../process/lock.js";
import { performUpdate, type UpdateDeps } from "./update-cmd.js";

const INITIAL_CONFIG = `host: "127.0.0.1"
port: 8317

auth-dir: "auths"
api-keys:
  - sk-cliproxyapi

remote-management:
  allow-remote: false
  secret-key: CLIPROXYAPI
  disable-control-panel: false
  disable-auto-update-panel: false
  panel-github-repository: "https://github.com/seakee/CPA-Manager-Plus"

logging-to-file: true
logs-max-total-size-mb: 32
error-logs-max-files: 10
`;

function createInitialConfig(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    fs.writeFileSync(fd, INITIAL_CONFIG);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

export async function runInit(updateDeps?: UpdateDeps): Promise<void> {
  const { layout, home } = createContext();
  apiBaseUrl();
  await withMiniCpaUpdateLock("init", async () => {
    await withMiniCpaLock("init", async () => {
      ensureDir(home);
      ensureDir(layout.stateDir);
      if (createInitialConfig(layout.configFile)) {
        console.log(`Created    ${layout.configFile}`);
        console.log(
          "Config     One-time local bootstrap; change the fixed keys in CLIProxyAPI before exposing it",
        );
      } else {
        console.log(`Exists     ${layout.configFile} (left untouched)`);
      }
    });
    console.log(`MiniCPA root  ${miniCpaRoot()}`);
    console.log(`Home          ${home}`);
    console.log("Component     Ensuring latest CLIProxyAPI binary");
    await performUpdate(home, {}, updateDeps);
    console.log("Next:");
    console.log("  cpa start");
    console.log("  cpa web");
  });
}
