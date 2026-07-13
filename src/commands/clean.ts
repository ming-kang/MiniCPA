import fs from "node:fs";
import { miniCpaTempRoot } from "../paths.js";
import { directorySizeBytes, formatBytes } from "../util.js";

/**
 * Remove MiniCPA temp downloads/extract staging only.
 * Never touches instance homes, config, binary, or running processes.
 */
export async function runClean(): Promise<void> {
  const temp = miniCpaTempRoot();
  if (!fs.existsSync(temp)) {
    console.log(`Temp      ${temp}`);
    console.log("Nothing to clean");
    return;
  }

  const size = directorySizeBytes(temp);
  fs.rmSync(temp, { recursive: true, force: true });
  console.log(`Cleaned   ${temp} (${formatBytes(size)})`);
}
