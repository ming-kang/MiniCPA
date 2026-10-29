import fs from "node:fs";
import path from "node:path";
import { MAX_CONFIG_BYTES, readConfigYaml } from "./config-yaml.js";
import { writeFileAtomic } from "./fs-atomic.js";
import { ensureDir } from "./paths.js";

export const CONFIG_BACKUP_KEEP = 3;

/** Fixed slots, newest first. No index, timestamps, hashes, or unbounded history. */
export function configBackupPaths(configPath: string): string[] {
  const directory = path.join(path.dirname(configPath), "backups", "config");
  return Array.from({ length: CONFIG_BACKUP_KEEP }, (_, index) =>
    path.join(directory, `config.${index + 1}.yaml`),
  );
}

/** Save the exact pre-write text, promoting repeated content instead of duplicating it. */
export function backupConfigYaml(configPath: string, yaml = readConfigYaml(configPath)): string {
  const paths = configBackupPaths(configPath);
  if (Buffer.byteLength(yaml) > MAX_CONFIG_BYTES) {
    throw new Error("Config backup exceeds the 4 MiB size limit");
  }
  const directory = path.dirname(paths[0]!);
  for (const parent of [path.dirname(directory), directory]) {
    if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) {
      throw new Error(`Refusing symlinked config backup directory: ${parent}`);
    }
  }
  const previous = paths.map((file) => (fs.existsSync(file) ? readConfigYaml(file) : undefined));
  const snapshots = [
    yaml,
    ...new Set(previous.filter((text) => text !== undefined && text !== yaml)),
  ].slice(0, CONFIG_BACKUP_KEEP);
  ensureDir(path.dirname(directory));
  ensureDir(directory);
  // Preserve each displaced snapshot before replacing a newer slot. If any write
  // fails, the caller has not overwritten config.yaml and must abort that write.
  for (let index = paths.length - 1; index >= 0; index--) {
    const snapshot = snapshots[index];
    if (snapshot === undefined) {
      if (previous[index] !== undefined) fs.unlinkSync(paths[index]!);
    } else if (snapshot !== previous[index]) {
      writeFileAtomic(paths[index]!, snapshot);
    }
  }
  return paths[0]!;
}

/** User-authorized migration: only old config backups, never binaries or recovery files. */
export function removeLegacyConfigBackups(configPath: string): {
  removed: number;
  failures: string[];
} {
  const directory = path.dirname(configPath);
  const prefix = `${path.basename(configPath)}.bak.`;
  if (!fs.existsSync(directory)) return { removed: 0, failures: [] };
  let removed = 0;
  const failures: string[] = [];
  const legacySuffix = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:\.\d+)?$/;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      !entry.name.startsWith(prefix) ||
      !legacySuffix.test(entry.name.slice(prefix.length)) ||
      entry.isDirectory()
    )
      continue;
    const file = path.join(directory, entry.name);
    try {
      fs.unlinkSync(file);
      removed++;
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { removed, failures };
}
