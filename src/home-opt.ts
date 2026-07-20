import type { Command } from "commander";

/**
 * Resolve `--home` from the command chain (subcommand first, then parents).
 * Only returns a value that was actually provided — never invents a default.
 */
export function resolveHomeOption(cmd: Command): string | undefined {
  let current: Command | null = cmd;
  while (current) {
    const opts = current.opts() as { home?: string };
    // Prefer values actually passed on this command (Commander tracks sources).
    const source =
      typeof current.getOptionValueSource === "function"
        ? current.getOptionValueSource("home")
        : undefined;
    if (source === "cli" || source === "env") {
      const home = opts.home?.trim();
      if (home) return home;
    } else if (opts.home?.trim() && source !== "default") {
      // Older Commander without sources, or explicit non-default.
      return opts.home.trim();
    }
    current = current.parent;
  }

  // Fallback: first non-empty home on the chain (covers explicit opts without sources).
  current = cmd;
  while (current) {
    const home = (current.opts() as { home?: string }).home?.trim();
    const source =
      typeof current.getOptionValueSource === "function"
        ? current.getOptionValueSource("home")
        : undefined;
    if (home && source !== "default") return home;
    current = current.parent;
  }
  return undefined;
}

/** Attach a standard `--home` option to a subcommand (no default). */
export function addHomeOption(cmd: Command): Command {
  return cmd.option("--home <dir>", "CPA_HOME override");
}
