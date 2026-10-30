import fs from "node:fs";
import path from "node:path";
import { miniCpaTempRoot } from "./paths.js";

export const TEMP_MIN_AGE_MS = 60 * 60 * 1000;

function privateTempRoot(): string {
  const root = miniCpaTempRoot();
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) {
    throw new Error(`Refusing symlinked MiniCPA temp root: ${root}`);
  }
  return root;
}

export async function cleanupPreviousUpdateOperations(): Promise<void> {
  const directory = path.join(privateTempRoot(), "operations");
  if (!fs.existsSync(directory)) return;
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Refusing symlinked update operations directory: ${directory}`);
  }
  for (const entry of entries(directory)) {
    const file = path.join(directory, entry.name);
    try {
      await fs.promises.rm(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      throw new Error(
        `Could not clear previous update operation ${file}. Close programs using staging files and retry.`,
        { cause: error },
      );
    }
  }
}

function* entries(directory: string): Generator<fs.Dirent> {
  const handle = fs.opendirSync(directory);
  try {
    while (true) {
      const entry = handle.readSync();
      if (entry === null) break;
      yield entry;
    }
  } finally {
    handle.closeSync();
  }
}

function* cleanupCandidates(root: string): Generator<string> {
  for (const entry of entries(root)) {
    const file = path.join(root, entry.name);
    // Legacy support: judge each download/operation by its own age rather than shared parent.
    if (entry.isDirectory() && (entry.name === "downloads" || entry.name === "operations")) {
      for (const child of entries(file)) yield path.join(file, child.name);
    } else {
      yield file;
    }
  }
}

export type TempCleanupResult = {
  removed: number;
  recent: number;
  failures: string[];
};

export async function cleanupTempFiles(options?: {
  minAgeMs?: number;
  maxEntries?: number;
}): Promise<TempCleanupResult> {
  const root = privateTempRoot();
  const result: TempCleanupResult = { removed: 0, recent: 0, failures: [] };
  if (!fs.existsSync(root)) return result;
  const cutoff = Date.now() - (options?.minAgeMs ?? TEMP_MIN_AGE_MS);
  let examined = 0;
  for (const file of cleanupCandidates(root)) {
    if (examined++ >= (options?.maxEntries ?? Infinity)) break;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      result.failures.push(`${file}: ${String(error)}`);
      continue;
    }
    if (stat.mtimeMs > cutoff) {
      result.recent++;
      continue;
    }
    try {
      await fs.promises.rm(file, { recursive: true, force: true });
      result.removed++;
    } catch (error) {
      result.failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const directory of [path.join(root, "downloads"), path.join(root, "operations"), root]) {
    try {
      await fs.promises.rmdir(directory);
    } catch {
      /* ignore */
    }
  }
  return result;
}

export async function removeTempOperation(
  directory: string,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await fs.promises.rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  } catch (error) {
    warn(`Warning: could not remove temporary directory ${directory}: ${String(error)}`);
  }
}
