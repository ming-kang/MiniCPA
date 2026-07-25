import { resolveCpaHome, cpaLayout, type CpaLayout } from "./paths.js";

export type CommandContext = {
  home: string;
  layout: CpaLayout;
};

export function createContext(): CommandContext {
  const home = resolveCpaHome();
  return { home, layout: cpaLayout(home) };
}

export function printHome(ctx: CommandContext): void {
  console.log(`CPA home  ${ctx.home}`);
}