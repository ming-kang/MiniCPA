import { formatCliError } from "../cli-errors.js";
import { createContext, printHome } from "../context.js";
import { withMiniCpaLock } from "../process/lock.js";
import { checkBinaryUpdate, updateBinary } from "../update/binary.js";
import { checkPanelUpdate, updatePanel, type PanelSkipReason } from "../update/panel.js";
import { consoleUpdateReporter } from "../update/reporter.js";

export function assertUpdateScopeFlags(opts: {
  all?: boolean;
  binary?: boolean;
  panel?: boolean;
  version?: string;
  insecure?: boolean;
}): void {
  const selected = [opts.all, opts.binary, opts.panel].filter(Boolean).length;
  if (selected > 1) {
    throw new Error("Use only one of --all, --binary, or --panel");
  }
  // --version / --insecure only reach updateBinary(); runUpdate returns early for
  // --panel, so accepting them there would silently ignore the user's request.
  if (opts.panel && (opts.version !== undefined || opts.insecure === true)) {
    throw new Error(
      "--version and --insecure apply to the CPA binary only; they cannot be combined with --panel",
    );
  }
}

/** Exit rule documented for `cpa update check`: 0 only when everything is current. */
export function updateCheckExitCode(result: {
  binaryUpToDate: boolean;
  panelUpToDate: boolean;
  binaryError: boolean;
  panelError: boolean;
}): number {
  const { binaryUpToDate, panelUpToDate, binaryError, panelError } = result;
  return binaryUpToDate && panelUpToDate && !binaryError && !panelError ? 0 : 1;
}

export type UpdateCheckDeps = {
  checkBinaryUpdate: typeof checkBinaryUpdate;
  checkPanelUpdate: typeof checkPanelUpdate;
};

const realUpdateCheckDeps: UpdateCheckDeps = { checkBinaryUpdate, checkPanelUpdate };

/** Column width for the per-leg labels in `cpa update check` output. */
const CHECK_LABEL_WIDTH = 12;

/** `"CPA binary"` / `"Panel"` padded so the current/latest columns line up. */
function checkLabel(name: string): string {
  return name.padEnd(CHECK_LABEL_WIDTH);
}

export async function runUpdateCheck(deps: UpdateCheckDeps = realUpdateCheckDeps): Promise<void> {
  const ctx = createContext();
  printHome(ctx);

  // A failed check is reported inline (like the panel leg below) instead of
  // aborting the command: `cpa update check` is a scripted health gate, and one
  // unreachable leg must not hide the verdict for the other.
  let binaryUpToDate = true;
  let binaryError = false;
  try {
    const binary = await deps.checkBinaryUpdate(ctx.home);
    binaryUpToDate = binary.upToDate;
    console.log(
      `${checkLabel("CPA binary")}current=${binary.current ?? "-"}  latest=${binary.latest}  ${
        binary.upToDate ? "up-to-date" : "update available"
      }`,
    );
  } catch (err) {
    binaryError = true;
    console.log(`${checkLabel("CPA binary")}error (${formatCliError(err)})`);
  }

  let panelUpToDate = true;
  let panelError = false;
  try {
    const panel = await deps.checkPanelUpdate(ctx.home);
    panelUpToDate = panel.upToDate;
    console.log(
      `${checkLabel("Panel")}current=${panel.current ?? "-"}  latest=${panel.latest}  ${
        panel.upToDate ? "up-to-date" : "update available"
      }`,
    );
  } catch (err) {
    panelError = true;
    console.log(`${checkLabel("Panel")}error (${formatCliError(err)})`);
  }

  // Exit 1 when outdated or when a check failed (do not treat errors as up-to-date).
  process.exitCode = updateCheckExitCode({
    binaryUpToDate,
    panelUpToDate,
    binaryError,
    panelError,
  });
}

function printPanelResult(result: {
  version: string;
  skipped: boolean;
  reason?: PanelSkipReason;
}): void {
  if (result.skipped) {
    if (result.reason === "config-opt-out") {
      console.log(
        "Panel update skipped (remote-management.disable-auto-update-panel is true; use --force to override).",
      );
    } else {
      console.log(
        result.version
          ? `Panel already ${result.version} (use --force to reinstall)`
          : "Panel already up-to-date (use --force to reinstall)",
      );
    }
  } else {
    console.log(`Panel updated to ${result.version}`);
  }
}

export type UpdateDeps = {
  updateBinary: typeof updateBinary;
  updatePanel: typeof updatePanel;
};

const realUpdateDeps: UpdateDeps = { updateBinary, updatePanel };

export async function runUpdate(
  opts: {
    /** Update panel only */
    panelOnly?: boolean;
    /** Binary only (skip panel). Default is binary + panel. */
    binaryOnly?: boolean;
    version?: string;
    /** Re-download even if already latest. */
    force?: boolean;
    /** Skip binary checksum verification (unsafe). */
    insecure?: boolean;
  },
  deps: UpdateDeps = realUpdateDeps,
): Promise<void> {
  const ctx = createContext();
  printHome(ctx);

  const reporter = consoleUpdateReporter();
  await withMiniCpaLock("update", async () => {
    if (opts.panelOnly) {
      try {
        printPanelResult(
          await deps.updatePanel(ctx.home, { force: opts.force, trigger: "explicit", reporter }),
        );
      } catch (err) {
        // Name the leg that failed: a raw "GitHub API 403 …" as the final line
        // reads as if the whole command (and the binary) had failed.
        throw new Error(`Panel update failed: ${formatCliError(err)}`, { cause: err });
      }
      return;
    }

    // Default: replace binary + panel. Running CPA is stopped/restarted automatically.
    const binary = await deps.updateBinary(ctx.home, {
      version: opts.version,
      force: opts.force,
      insecure: opts.insecure,
      reporter,
    });
    if (binary.skipped) {
      console.log(`CPA already ${binary.version} (use --force to reinstall)`);
    } else {
      console.log(`CPA updated to ${binary.version}${binary.restarted ? " (restarted)" : ""}`);
    }

    if (opts.binaryOnly) {
      console.log("Panel skipped (--binary).");
      return;
    }

    // The binary leg has already succeeded and printed its outcome, so a panel
    // failure must not become the command's only visible result. Report it as a
    // warning, keep exit 1 (the update is only partially done), and point at the
    // narrow retry that does not touch the binary again.
    try {
      printPanelResult(await deps.updatePanel(ctx.home, { force: opts.force, reporter }));
    } catch (err) {
      console.error(`Warning: panel update failed: ${formatCliError(err)}`);
      console.error("The CPA binary result above stands. Retry the panel with: cpa update --panel");
      process.exitCode = 1;
    }
  });
}
