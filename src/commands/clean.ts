import fs from "node:fs";
import path from "node:path";
import { miniCpaTempRoot } from "../paths.js";
import { directorySizeBytes, formatBytes } from "../util.js";

/** Only remove temp entries older than this (avoid racing an in-flight update). */
export const CLEAN_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Remove MiniCPA temp downloads/extract staging only.
 * Never touches instance homes, config, binary, or running processes.
 * Skips entries modified within the last hour so concurrent `cpa update` is safer.
 */
export async function runClean(options?: { minAgeMs?: number }): Promise<void> {
  const temp = miniCpaTempRoot();
  if (!fs.existsSync(temp)) {
    console.log(`Temp      ${temp}`);
    console.log("Nothing to clean");
    return;
  }

  const minAgeMs = options?.minAgeMs ?? CLEAN_MIN_AGE_MS;
  const cutoff = Date.now() - minAgeMs;
  let removedBytes = 0;
  let removedCount = 0;
  let skippedRecent = 0;

  const entries = fs.readdirSync(temp, { withFileTypes: true });
  if (entries.length === 0) {
    console.log(`Temp      ${temp}`);
    console.log("Nothing to clean");
    return;
  }

  for (const entry of entries) {
    const full = path.join(temp, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > cutoff) {
      skippedRecent += 1;
      continue;
    }
    const size = directorySizeBytes(full);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removedBytes += size;
      removedCount += 1;
    } catch (err) {
      console.log(`[warn] could not remove ${full}: ${(err as Error).message}`);
    }
  }

  // Drop empty root if fully cleaned.
  try {
    if (fs.readdirSync(temp).length === 0) {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }

  console.log(`Temp      ${temp}`);
  if (removedCount === 0 && skippedRecent > 0) {
    console.log(
      `Nothing old enough to clean (${skippedRecent} recent entr${skippedRecent === 1 ? "y" : "ies"} kept; min age ${Math.round(minAgeMs / 60000)}m)`,
    );
    return;
  }
  console.log(
    `Cleaned   ${removedCount} entr${removedCount === 1 ? "y" : "ies"} (${formatBytes(removedBytes)})` +
      (skippedRecent > 0 ? `; kept ${skippedRecent} recent` : ""),
  );
}
