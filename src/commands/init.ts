import fs from "node:fs";
import { apiBaseUrl } from "../api-url.js";
import { createContext, printRow } from "../context.js";
import { ensureDir } from "../paths.js";
import { withMiniCpaLock, withMiniCpaUpdateLock } from "../process/lock.js";
import { performUpdate, type UpdateDeps } from "./update-cmd.js";

const INITIAL_API_KEY = "sk-cliproxyapi";
const INITIAL_MANAGEMENT_KEY = "CLIPROXYAPI";

// The panel repository is a deliberate trust decision; see docs/security.md §5.
const INITIAL_CONFIG = `host: "127.0.0.1"
port: 8317

auth-dir: "auths"
api-keys:
  - ${INITIAL_API_KEY}

remote-management:
  allow-remote: false
  secret-key: ${INITIAL_MANAGEMENT_KEY}
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
    const created = await withMiniCpaLock("init", async () => {
      ensureDir(home);
      ensureDir(layout.stateDir);
      return createInitialConfig(layout.configFile);
    });
    if (created) {
      printRow("Created", layout.configFile);
      // CPA hashes secret-key on first start, so this is the only place it stays readable.
      printRow("Panel key", `${INITIAL_MANAGEMENT_KEY}  (management password for cpa web)`);
      printRow("API key", INITIAL_API_KEY);
      console.log("Change both in the Web panel before exposing CLIProxyAPI beyond this machine.");
    } else {
      printRow("Config", `${layout.configFile} (exists, left untouched)`);
    }
    await performUpdate(home, {}, updateDeps);
    console.log("");
    console.log("Next: cpa start, then cpa web");
  });
}
