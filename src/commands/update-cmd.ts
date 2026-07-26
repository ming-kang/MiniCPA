import { formatCliError } from "../cli-errors.js";
import { createContext, printHome } from "../context.js";
import { withMiniCpaLock } from "../process/lock.js";
import { checkBinaryUpdate, updateBinary } from "../update/binary.js";
import { checkPanelUpdate, updatePanel } from "../update/panel.js";
import { consoleUpdateReporter } from "../update/reporter.js";

export function assertUpdateScopeFlags(opts: {
  all?: boolean;
  binary?: boolean;
  panel?: boolean;
}): void {
  const selected = [opts.all, opts.binary, opts.panel].filter(Boolean).length;
  if (selected > 1) {
    throw new Error("Use only one of --all, --binary, or --panel");
  }
}

export async function runUpdateCheck(): Promise<void> {
  const ctx = createContext();
  printHome(ctx);

  const binary = await checkBinaryUpdate(ctx.home);
  console.log(
    `CPA binary  current=${binary.current ?? "-"}  latest=${binary.latest}  ${
      binary.upToDate ? "up-to-date" : "update available"
    }`,
  );

  let panelUpToDate = true;
  let panelError = false;
  try {
    const panel = await checkPanelUpdate(ctx.home);
    panelUpToDate = panel.upToDate;
    console.log(
      `Panel       current=${panel.current ?? "-"}  latest=${panel.latest}  ${
        panel.upToDate ? "up-to-date" : "update available"
      }`,
    );
  } catch (err) {
    panelError = true;
    console.log(`Panel       error (${formatCliError(err)})`);
  }

  // Exit 1 when outdated or when panel check failed (do not treat errors as up-to-date).
  process.exitCode = binary.upToDate && panelUpToDate && !panelError ? 0 : 1;
}

function printPanelResult(result: { version: string; skipped: boolean }): void {
  console.log(
    result.skipped
      ? `Panel already ${result.version} (use --force to reinstall)`
      : `Panel updated to ${result.version}`,
  );
}

export async function runUpdate(opts: {
  /** Update panel only */
  panelOnly?: boolean;
  /** Binary only (skip panel). Default is binary + panel. */
  binaryOnly?: boolean;
  version?: string;
  /** Re-download even if already latest. */
  force?: boolean;
  /** Skip binary checksum verification (unsafe). */
  insecure?: boolean;
}): Promise<void> {
  const ctx = createContext();
  printHome(ctx);

  const reporter = consoleUpdateReporter();
  await withMiniCpaLock("update", async () => {
    if (opts.panelOnly) {
      printPanelResult(await updatePanel(ctx.home, { force: opts.force, reporter }));
      return;
    }

    // Default: replace binary + panel. Running CPA is stopped/restarted automatically.
    const binary = await updateBinary(ctx.home, {
      version: opts.version,
      force: opts.force,
      insecure: opts.insecure,
      reporter,
    });
    if (binary.skipped) {
      console.log(`CPA already ${binary.version} (use --force to reinstall)`);
    } else {
      console.log(
        `CPA updated to ${binary.version}${binary.restarted ? " (restarted)" : ""}`,
      );
    }

    if (opts.binaryOnly) {
      console.log("Panel skipped (--binary).");
      return;
    }

    printPanelResult(await updatePanel(ctx.home, { force: opts.force, reporter }));
  });
}
