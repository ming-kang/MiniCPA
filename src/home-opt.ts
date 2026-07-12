import type { Command } from "commander";

export function resolveHomeOption(cmd: Command): string | undefined {
  let current: Command | null = cmd;
  while (current) {
    const home = (current.opts() as { home?: string }).home;
    if (home) return home;
    current = current.parent;
  }
  return undefined;
}