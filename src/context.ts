import { resolveCpaHome, cpaLayout, type CpaLayout } from "./paths.js";

export type CommandContext = {
  home: string;
  layout: CpaLayout;
};

export function createContext(opts?: { home?: string }): CommandContext {
  const home = resolveCpaHome(opts?.home);
  return { home, layout: cpaLayout(home) };
}

export function printHome(ctx: CommandContext): void {
  console.log(`CPA_HOME  ${ctx.home}`);
}