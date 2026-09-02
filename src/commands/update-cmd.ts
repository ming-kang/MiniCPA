import { formatCliError } from "../cli-errors.js";
import { createContext, printHome } from "../context.js";
import { withMiniCpaLock } from "../process/lock.js";
import { checkBinaryUpdate, updateBinary } from "../update/binary.js";
import { consoleUpdateReporter } from "../update/reporter.js";

/** Exit rule documented for `cpa update check`: 0 only when the binary is current. */
export function updateCheckExitCode(result: {
  binaryUpToDate: boolean;
  binaryError: boolean;
}): number {
  return result.binaryUpToDate && !result.binaryError ? 0 : 1;
}

export type UpdateCheckDeps = {
  checkBinaryUpdate: typeof checkBinaryUpdate;
};

const realUpdateCheckDeps: UpdateCheckDeps = { checkBinaryUpdate };

/** Column width for the component label in `cpa update check` output. */
const CHECK_LABEL_WIDTH = 13;

function checkLabel(name: string): string {
  return name.padEnd(CHECK_LABEL_WIDTH);
}

function checkRow(
  component: string,
  current: string | undefined,
  latest: string,
  status: string,
): string {
  return `${checkLabel(component)}current=${current ?? "(not installed)"}  latest=${latest}  ${status}`;
}

export async function runUpdateCheck(deps: UpdateCheckDeps = realUpdateCheckDeps): Promise<void> {
  const ctx = createContext();
  printHome(ctx);

  try {
    const binary = await deps.checkBinaryUpdate(ctx.home);
    console.log(
      checkRow(
        "CLIProxyAPI",
        binary.current,
        binary.latest,
        binary.upToDate ? "up to date" : "update available",
      ),
    );
    if (!binary.upToDate) {
      console.log("");
      console.log("Run: cpa update");
    }
    process.exitCode = updateCheckExitCode({
      binaryUpToDate: binary.upToDate,
      binaryError: false,
    });
  } catch (err) {
    console.log(`${checkLabel("CLIProxyAPI")}check failed: ${formatCliError(err)}`);
    process.exitCode = updateCheckExitCode({
      binaryUpToDate: false,
      binaryError: true,
    });
  }
}

function updateResultLine(
  result: {
    version: string;
    previousVersion?: string;
    restarted?: boolean;
  },
  explicitVersion = false,
): string {
  const restartSuffix = result.restarted ? " (restarted)" : "";
  if (!result.previousVersion) {
    return `CLIProxyAPI installed: ${result.version}${restartSuffix}`;
  }
  if (result.previousVersion === result.version) {
    return `CLIProxyAPI reinstalled: ${result.version}${restartSuffix}`;
  }
  if (explicitVersion) {
    return `CLIProxyAPI version changed: ${result.previousVersion} → ${result.version}${restartSuffix}`;
  }
  return `CLIProxyAPI updated: ${result.previousVersion} → ${result.version}${restartSuffix}`;
}

export type UpdateDeps = {
  updateBinary: typeof updateBinary;
};

export type UpdateOptions = {
  version?: string;
  /** Re-download even if already latest. */
  force?: boolean;
  /** Skip binary checksum verification (unsafe). */
  insecure?: boolean;
};

const realUpdateDeps: UpdateDeps = { updateBinary };

/** Execute the binary update for a caller that already owns the MiniCPA lock. */
export async function performUpdate(
  home: string,
  opts: UpdateOptions,
  deps: UpdateDeps = realUpdateDeps,
): Promise<void> {
  const binary = await deps.updateBinary(home, {
    version: opts.version,
    force: opts.force,
    insecure: opts.insecure,
    reporter: consoleUpdateReporter(),
  });
  if (binary.skipped) {
    console.log(`CLIProxyAPI is already up to date (${binary.version})`);
  } else {
    console.log(updateResultLine(binary, opts.version !== undefined));
  }
}

export async function runUpdate(
  opts: UpdateOptions,
  deps: UpdateDeps = realUpdateDeps,
): Promise<void> {
  const ctx = createContext();
  printHome(ctx);
  await withMiniCpaLock("update", () => performUpdate(ctx.home, opts, deps));
}
