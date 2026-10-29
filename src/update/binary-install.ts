import { RuntimeBinaryTransaction } from "../process/runtime.js";
import {
  resolveRunning,
  startDaemon,
  stopDaemon,
  waitForBinaryUnlocked,
  type RunningInfo,
  type StartOptions,
} from "../process/lifecycle.js";
import { patchInstallState, readInstallState } from "../state.js";
import { BinaryUpdateError } from "./binary-error.js";
import { silentUpdateReporter, type UpdateReporter } from "./reporter.js";

/** Apply config during commit and return the rollback for precisely that write. */
export type BinaryCommitHook = () => (() => void) | undefined;

/** Process-lifecycle seam: failure tests never launch or stop real CPA processes. */
export type BinaryUpdateDeps = {
  stopDaemon(home: string): Promise<boolean>;
  startDaemon(home: string, options?: StartOptions): Promise<RunningInfo>;
  resolveRunning(home: string): Promise<RunningInfo | undefined>;
  waitForBinaryUnlocked(home: string): Promise<void>;
};

export const defaultBinaryUpdateDeps: BinaryUpdateDeps = {
  stopDaemon,
  startDaemon,
  resolveRunning,
  waitForBinaryUnlocked,
};

/** Copy/fsync precede stop. The lifecycle-locked commit only replaces and restarts. */
export async function installBinaryPhase(
  home: string,
  args: {
    version: string;
    extractedExe: string;
    wasRunning: boolean;
    currentVersion?: string;
    transaction?: RuntimeBinaryTransaction;
    beforeInstall?: BinaryCommitHook;
  },
  deps: BinaryUpdateDeps = defaultBinaryUpdateDeps,
  reporter: UpdateReporter = silentUpdateReporter,
): Promise<{ restarted: boolean }> {
  const { version, wasRunning, currentVersion } = args;
  const transaction = args.transaction ?? new RuntimeBinaryTransaction(home);
  const recordedCurrentVersion = readInstallState(home).runtimeVersion;
  try {
    if (!args.transaction) transaction.prepare(args.extractedExe);
    const rollbackConfig = args.beforeInstall?.();
    if (wasRunning) {
      reporter.info("Stopping CLIProxyAPI to install the update…");
      try {
        await deps.stopDaemon(home);
      } catch (error) {
        try {
          rollbackConfig?.();
        } catch (configError) {
          throw new Error(`${String(error)}\nCould not restore config: ${String(configError)}`, {
            cause: error,
          });
        }
        throw error;
      }
    }

    try {
      await deps.waitForBinaryUnlocked(home);
      transaction.install();
      if (wasRunning) {
        reporter.info("Restarting CLIProxyAPI…");
        await deps.startDaemon(home);
      }
      patchInstallState(home, {
        runtimeVersion: version,
        lastUpdateCheck: new Date().toISOString(),
      });
      transaction.commit();
      return { restarted: wasRunning };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reporter.warn("CLIProxyAPI update failed; recovering the previous installation…");
      // Do not change either the binary or config under a half-started process
      // that cannot be safely stopped. Keep both recovery files for the user.
      try {
        if (await deps.resolveRunning(home)) await deps.stopDaemon(home);
      } catch (stopError) {
        throw new BinaryUpdateError(
          `${message}\nRecovery could not stop CLIProxyAPI: ${String(stopError)}`,
          false,
        );
      }
      const { restored, previousAvailable } = transaction.rollback();
      const recoveryErrors: string[] = [];
      try {
        rollbackConfig?.();
      } catch (configError) {
        recoveryErrors.push(`Could not restore config: ${String(configError)}`);
      }
      try {
        patchInstallState(home, {
          runtimeVersion: previousAvailable
            ? (currentVersion ?? recordedCurrentVersion)
            : undefined,
          lastUpdateCheck: new Date().toISOString(),
        });
      } catch (stateError) {
        recoveryErrors.push(`Could not restore install metadata: ${String(stateError)}`);
      }
      const failureMessage = [message, ...recoveryErrors].join("\n");
      if (wasRunning) {
        if (!previousAvailable) {
          throw new BinaryUpdateError(failureMessage, false, { previousAvailable: false });
        }
        try {
          await deps.startDaemon(home);
        } catch (restartError) {
          throw new BinaryUpdateError(
            `${failureMessage}\nRestart error: ${String(restartError)}`,
            false,
            { previousRestored: restored },
          );
        }
        throw new BinaryUpdateError(failureMessage, true, { previousRestored: restored });
      }
      if (recoveryErrors.length > 0) throw new Error(failureMessage, { cause: error });
      throw error;
    }
  } finally {
    transaction.discard();
  }
}
