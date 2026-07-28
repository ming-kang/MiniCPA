import fs from "node:fs";
import path from "node:path";
import { miniCpaTempRoot } from "../paths.js";
import { withMiniCpaLock } from "../process/lock.js";
import { directorySizeBytes, formatBytes } from "../util.js";

/** Only remove staging entries older than this. */
export const CLEAN_MIN_AGE_MS = 60 * 60 * 1000;

/** Remove only old private staging entries while holding the global MiniCPA lock. */
export async function runClean(options?: { minAgeMs?: number }): Promise<void> {
  await withMiniCpaLock("clean", async () => {
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
    let failed = 0;

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
        mtimeMs = fs.lstatSync(full).mtimeMs;
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
        failed += 1;
      }
    }

    try {
      if (fs.readdirSync(temp).length === 0) {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }

    console.log(`Temp      ${temp}`);
    if (removedCount === 0 && failed === 0 && skippedRecent > 0) {
      console.log(
        `Nothing old enough to clean (${skippedRecent} recent entr${skippedRecent === 1 ? "y" : "ies"} kept; min age ${Math.round(minAgeMs / 60000)}m)`,
      );
      return;
    }
    console.log(
      `Cleaned   ${removedCount} entr${removedCount === 1 ? "y" : "ies"} (${formatBytes(removedBytes)})` +
        (skippedRecent > 0 ? `; kept ${skippedRecent} recent` : "") +
        (failed > 0
          ? `; ${failed} could not be removed (retry after closing programs / stopping an active update)`
          : ""),
    );
    // `cpa clean && echo freed` must not claim success when nothing was freed.
    if (failed > 0) process.exitCode = 1;
  });
}
