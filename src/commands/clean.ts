import { miniCpaTempRoot } from "../paths.js";
import { withMiniCpaUpdateLock } from "../process/lock.js";
import { cleanupTempFiles, TEMP_MIN_AGE_MS } from "../temp-files.js";

/** Serialize with downloads, but never hold the lifecycle lock during recursive removal. */
export async function runClean(options?: { minAgeMs?: number }): Promise<void> {
  await withMiniCpaUpdateLock("clean", async () => {
    const result = await cleanupTempFiles(options);
    console.log(`Temp      ${miniCpaTempRoot()}`);
    for (const failure of result.failures) console.log(`[warn] could not remove ${failure}`);
    if (result.removed === 0 && result.failures.length === 0) {
      console.log(
        result.recent > 0
          ? `Nothing old enough to clean (${result.recent} recent entries kept; min age ${Math.round((options?.minAgeMs ?? TEMP_MIN_AGE_MS) / 60000)}m)`
          : "Nothing to clean",
      );
      return;
    }
    console.log(
      `Cleaned   ${result.removed} entr${result.removed === 1 ? "y" : "ies"}` +
        (result.recent > 0 ? `; kept ${result.recent} recent` : "") +
        (result.failures.length > 0 ? `; ${result.failures.length} could not be removed` : ""),
    );
    if (result.failures.length > 0) process.exitCode = 1;
  });
}
