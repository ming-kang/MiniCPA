import type { RuntimeBinaryTransaction } from "../process/runtime.js";
import {
  resolveRunning,
  startDaemon,
  stopDaemon,
  type RunningInfo,
  type StartOptions,
} from "../process/lifecycle.js";
import { readInstallState, writeInstallState } from "../state.js";
import { BinaryUpdateError } from "./binary-error.js";
import { silentUpdateReporter, type UpdateReporter } from "./reporter.js";

export type BinaryUpdateDeps = {
  stopDaemon(home: string): Promise<boolean>;
  startDaemon(home: string, options?: StartOptions): Promise<RunningInfo>;
  resolveRunning(home: string): Promise<RunningInfo | undefined>;
};

export const defaultBinaryUpdateDeps: BinaryUpdateDeps = {
  stopDaemon,
  startDaemon,
  resolveRunning,
};

export async function installBinaryPhase(
  home: string,
  args: {
    version: string;
    wasRunning: boolean;
    currentVersion?: string;
    transaction: RuntimeBinaryTransaction;
  },
  deps: BinaryUpdateDeps = defaultBinaryUpdateDeps,
  reporter: UpdateReporter = silentUpdateReporter,
): Promise<{ restarted: boolean }> {
  const { version, wasRunning, currentVersion, transaction } = args;
  const recordedCurrentVersion = readInstallState(home).runtimeVersion;
  if (wasRunning) {
    reporter.info("Stopping CLIProxyAPI to install the update…");
    await deps.stopDaemon(home);
  }

  try {
    transaction.install();
    if (wasRunning) {
      reporter.info("Restarting CLIProxyAPI…");
      await deps.startDaemon(home);
    }
    writeInstallState(home, { runtimeVersion: version });
    transaction.commit();
    return { restarted: wasRunning };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reporter.warn("CLIProxyAPI update failed; recovering the previous installation…");
    // Stop a half-started replacement before restoring the previous binary.
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
      writeInstallState(home, {
        runtimeVersion: previousAvailable ? (currentVersion ?? recordedCurrentVersion) : undefined,
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
}
