import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findTestFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return findTestFiles(file);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [file] : [];
  });
}

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const testFiles = findTestFiles(srcDir).sort();

const filters = process.argv.slice(2);
const selected = filters.length
  ? testFiles.filter((file) => filters.some((needle) => file.includes(needle)))
  : testFiles;

if (selected.length === 0) {
  console.error(`No test files match: ${filters.join(", ")}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...selected], {
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
