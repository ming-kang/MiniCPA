import { resolveCpaHome, cpaLayout, type CpaLayout } from "./paths.js";

export type CommandContext = {
  home: string;
  layout: CpaLayout;
};

export function createContext(): CommandContext {
  const home = resolveCpaHome();
  return { home, layout: cpaLayout(home) };
}

/** One aligned `Label        value` line; every command shares the same label column. */
export function printRow(label: string, value: string): void {
  console.log(`${label.padEnd(13)}${value}`);
}
