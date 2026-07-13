#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withCliErrors } from "./cli-errors.js";
import { runClean } from "./commands/clean.js";
import { runDoctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import {
  runLogs,
  runOpen,
  runRestart,
  runStart,
  runStatus,
  runStop,
  runTui,
} from "./commands/lifecycle-cmd.js";
import { assertUpdateScopeFlags, runUpdate, runUpdateCheck } from "./commands/update-cmd.js";
import { createContext } from "./context.js";
import { resolveHomeOption } from "./home-opt.js";
import { defaultCpaHome, miniCpaRoot, miniCpaTempRoot } from "./paths.js";
import { readCurrentRuntimeVersion } from "./process/runtime.js";
import { readInstallState } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

const program = new Command();
program
  .name("cpa")
  .description("MiniCPA — install, run, and update CLIProxyAPI")
  .version(pkg.version)
  .option("--home <dir>", "CPA_HOME override for all commands")
  .showHelpAfterError(false)
  .exitOverride();

function homeOf(cmd: Command): string | undefined {
  return resolveHomeOption(cmd);
}

program
  .command("init")
  .description("Create CPA_HOME layout and register default home")
  .option("--home <dir>", "CPA_HOME directory", defaultCpaHome())
  .option("--force", "Overwrite config.yaml (backs up to config.yaml.bak.<timestamp>)")
  .action(
    withCliErrors(async (opts: { home: string; force?: boolean }, cmd: Command) => {
      await runInit({ home: homeOf(cmd) ?? opts.home, force: opts.force });
    }),
  );

program
  .command("start")
  .description("Start CPA in background (waits until HTTP is ready)")
  .option("--no-wait", "Do not wait for HTTP ready")
  .action(
    withCliErrors(async (opts: { wait?: boolean }, cmd: Command) => {
      await runStart({ home: homeOf(cmd), noWait: opts.wait === false });
    }),
  );

program.command("stop").description("Stop CPA").action(
  withCliErrors(async (_opts: unknown, cmd: Command) => {
    await runStop({ home: homeOf(cmd) });
  }),
);

program
  .command("restart")
  .description("Restart CPA")
  .option("--no-wait", "Do not wait for HTTP ready")
  .action(
    withCliErrors(async (opts: { wait?: boolean }, cmd: Command) => {
      await runRestart({ home: homeOf(cmd), noWait: opts.wait === false });
    }),
  );

program.command("status").description("Show CPA status").action(
  withCliErrors(async (_opts: unknown, cmd: Command) => {
    await runStatus({ home: homeOf(cmd) });
  }),
);

program.command("open").description("Open management UI in browser").action(
  withCliErrors(async (_opts: unknown, cmd: Command) => {
    await runOpen({ home: homeOf(cmd) });
  }),
);

program
  .command("logs")
  .description("Show CPA logs (stdout + stderr by default)")
  .option("-f, --follow", "Follow log output")
  .option("-n, --lines <n>", "Number of lines per file", "80")
  .option("--err", "Show error log only")
  .action(
    withCliErrors(async (opts: { follow?: boolean; lines: string; err?: boolean }, cmd: Command) => {
      await runLogs({
        home: homeOf(cmd),
        follow: opts.follow,
        lines: Number.parseInt(opts.lines, 10) || 80,
        errOnly: opts.err,
      });
    }),
  );

program.command("tui").description("Open official CPA terminal UI").action(
  withCliErrors(async (_opts: unknown, cmd: Command) => {
    await runTui({ home: homeOf(cmd) });
  }),
);

const updateCmd = program
  .command("update")
  .description("Replace CPA binary and management panel (default: both)");

updateCmd.command("check").description("Check for updates (exit 1 if any outdated)").action(
  withCliErrors(async (_opts: unknown, cmd: Command) => {
    await runUpdateCheck({ home: homeOf(cmd) });
  }),
);

updateCmd
  .option("--all", "Update binary and panel (default; kept for compatibility)")
  .option("--binary", "Update CPA binary only")
  .option("--panel", "Update management panel only")
  .option("--version <ver>", "Install specific CPA version (e.g. 7.2.66)")
  .option("--force", "Reinstall even if already latest (running CPA is always restarted on replace)")
  .option("--insecure", "Skip binary checksum verification (unsafe)")
  .action(
    withCliErrors(
      async (
        opts: {
          all?: boolean;
          binary?: boolean;
          panel?: boolean;
          version?: string;
          force?: boolean;
          insecure?: boolean;
        },
        cmd: Command,
      ) => {
        assertUpdateScopeFlags(opts);
        await runUpdate({
          home: homeOf(cmd),
          panelOnly: !!opts.panel,
          binaryOnly: !!opts.binary,
          version: opts.version,
          force: opts.force,
          insecure: opts.insecure,
        });
      },
    ),
  );

program.command("doctor").description("Validate CPA_HOME and runtime").action(
  withCliErrors(async (_opts: unknown, cmd: Command) => {
    await runDoctor({ home: homeOf(cmd) });
  }),
);

program
  .command("clean")
  .description("Remove MiniCPA temp downloads/extract (never touches instance home)")
  .action(
    withCliErrors(async () => {
      await runClean();
    }),
  );

program
  .command("version")
  .description("Show MiniCPA and CPA runtime versions")
  .action(
    withCliErrors(async (_opts: unknown, cmd: Command) => {
      const ctx = createContext({ home: homeOf(cmd) });
      const state = readInstallState(ctx.home);
      const runtime = await readCurrentRuntimeVersion(ctx.home);
      console.log(`minicpa   ${pkg.version}`);
      console.log(`CPA_HOME  ${ctx.home}`);
      console.log(`cpa       ${runtime ?? "(not installed)"}`);
      console.log(`panel     ${state.panelVersion ?? "-"}`);
    }),
  );

program
  .command("home")
  .description("Print CPA instance directory (config, auths, binary)")
  .action(
    withCliErrors(async (_opts: unknown, cmd: Command) => {
      const ctx = createContext({ home: homeOf(cmd) });
      console.log(ctx.home);
    }),
  );

program.command("root").description("Print MiniCPA root (persistent data)").action(() => {
  console.log(miniCpaRoot());
});

program.command("temp").description("Print MiniCPA temp dir (downloads / extract)").action(() => {
  console.log(miniCpaTempRoot());
});

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // Commander exitOverride throws on --help / unknown commands / version.
  const e = err as { code?: string; message?: string; exitCode?: number };
  if (e.code === "commander.helpDisplayed" || e.code === "commander.version") {
    process.exitCode = 0;
  } else if (e.code === "commander.help") {
    process.exitCode = 0;
  } else {
    if (e.message) console.error(e.message);
    process.exitCode = typeof e.exitCode === "number" ? e.exitCode : 1;
  }
}
