import { createContext, printHome } from "../context.js";
import { checkBinaryUpdate, updateBinary } from "../update/binary.js";
import { checkPanelUpdate, updatePanel } from "../update/panel.js";

export async function runUpdateCheck(opts: { home?: string }): Promise<void> {
  const ctx = createContext(opts);
  printHome(ctx);

  const binary = await checkBinaryUpdate(ctx.home);
  console.log(`CPA binary  current=${binary.current ?? "-"}  latest=${binary.latest}  ${
    binary.upToDate ? "up-to-date" : "update available"
  }`);

  try {
    const panel = await checkPanelUpdate(ctx.home);
    console.log(`Panel       current=${panel.current ?? "-"}  latest=${panel.latest}  ${
      panel.upToDate ? "up-to-date" : "update available"
    }`);
  } catch (err) {
    console.log(`Panel       skipped (${(err as Error).message})`);
  }
}

export async function runUpdate(opts: {
  home?: string;
  all?: boolean;
  panelOnly?: boolean;
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

  if (opts.all) {
    const binary = await updateBinary(ctx.home, { version: opts.version, force: opts.force });
    console.log(`CPA updated to ${binary.version}`);
    const panel = await updatePanel(ctx.home);
    console.log(`Panel updated to ${panel.version}`);
    return;
  }

  const binary = await updateBinary(ctx.home, { version: opts.version, force: opts.force });
  console.log(`CPA updated to ${binary.version}`);
}