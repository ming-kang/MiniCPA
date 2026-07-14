import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

function findTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return findTestFiles(file);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [file] : [];
  });
}

const testFiles = findTestFiles("src").sort();
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
