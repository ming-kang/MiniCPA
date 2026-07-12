import { createContext, printHome } from "../context.js";
import { checkBinaryUpdate, updateBinary } from "../update/binary.js";
import { checkPanelUpdate, updatePanel } from "../update/panel.js";

export async function runUpdateCheck(opts: { home?: string }): Promise<void> {
  const ctx = createContext(opts);
  printHome(ctx);

  const binary = await checkBinaryUpdate(ctx.home);
  console.log(
    `CPA binary  current=${binary.current ?? "-"}  latest=${binary.latest}  ${
      binary.upToDate ? "up-to-date" : "update available"
    }`,
  );

  try {
    const panel = await checkPanelUpdate(ctx.home);
    console.log(
      `Panel       current=${panel.current ?? "-"}  latest=${panel.latest}  ${
        panel.upToDate ? "up-to-date" : "update available"
      }`,
    );
  } catch (err) {
    console.log(`Panel       skipped (${(err as Error).message})`);
  }
}

export async function runUpdate(opts: {
  home?: string;
  /** Update panel only */
  panelOnly?: boolean;
  /** Binary only (skip panel). Default is binary + panel. */
  binaryOnly?: boolean;
  version?: string;
  force?: boolean;
}): Promise<void> {
  const ctx = createContext(opts);
  printHome(ctx);

  if (opts.panelOnly) {
    const result = await updatePanel(ctx.home);
    console.log(`Panel updated to ${result.version}`);
    return;
  }

  // Default: replace binary + panel (full update).
  const binary = await updateBinary(ctx.home, { version: opts.version, force: opts.force });
  console.log(
    `CPA updated to ${binary.version}${binary.restarted ? " (restarted)" : ""}`,
  );

  if (opts.binaryOnly) {
    console.log("Panel skipped (--binary). Use default update or --panel for the UI.");
    return;
  }

  const panel = await updatePanel(ctx.home);
  console.log(`Panel updated to ${panel.version}`);
}
