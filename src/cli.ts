#!/usr/bin/env node
import "./node-version-guard.js";
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
  parseLogLineCount,
} from "./commands/lifecycle-cmd.js";
import { assertUpdateScopeFlags, runUpdate, runUpdateCheck } from "./commands/update-cmd.js";
import { runVersion } from "./commands/version-cmd.js";
import { createContext } from "./context.js";
import { miniCpaRoot, miniCpaTempRoot } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
  version: string;
};

const program = new Command();
program
  .name("cpa")
  .description("MiniCPA — manage one CLIProxyAPI instance")
  .version(pkg.version)
  .showHelpAfterError(false)
  .exitOverride();

program
  .command("init")
  .description("Create the single CPA instance layout")
  .option("--force", "Overwrite config.yaml (backs up to config.yaml.bak.<timestamp>)")
  .action(
    withCliErrors(async (opts: { force?: boolean }) => {
      await runInit({ force: opts.force });
    }),
  );

program
  .command("start")
  .description("Start CPA in background (waits until HTTP is ready)")
  .option("--no-wait", "Do not wait for HTTP ready")
  .action(
    withCliErrors(async (opts: { wait?: boolean }) => {
      await runStart({ noWait: opts.wait === false });
    }),
  );

program
  .command("stop")
  .description("Stop CPA")
  .action(
    withCliErrors(async () => {
      await runStop();
    }),
  );

program
  .command("restart")
  .description("Restart CPA")
  .option("--no-wait", "Do not wait for HTTP ready")
  .action(
    withCliErrors(async (opts: { wait?: boolean }) => {
      await runRestart({ noWait: opts.wait === false });
    }),
  );

program
  .command("status")
  .description("Show CPA status")
  .action(
    withCliErrors(async () => {
      await runStatus();
    }),
  );

program
  .command("open")
  .description("Open management UI in browser")
  .action(
    withCliErrors(async () => {
      await runOpen();
    }),
  );

program
  .command("logs")
  .description("Show CPA logs (stdout + stderr by default)")
  .option("-f, --follow", "Follow log output")
  .option("-n, --lines <n>", "Number of lines per file", "80")
  .option("--err", "Show error log only")
  .action(
    withCliErrors(async (opts: { follow?: boolean; lines: string; err?: boolean }) => {
      await runLogs({
        follow: opts.follow,
        lines: parseLogLineCount(opts.lines),
        errOnly: opts.err,
      });
    }),
  );

program
  .command("tui")
  .description("Open official CPA terminal UI")
  .action(
    withCliErrors(async () => {
      await runTui();
    }),
  );

const updateCmd = program
  .command("update")
  .description("Replace CPA binary and management panel (default: both)");

updateCmd
  .command("check")
  .description("Check for updates (exit 1 if any outdated)")
  .action(
    withCliErrors(async () => {
      await runUpdateCheck();
    }),
  );

updateCmd
  .option("--all", "Update binary and panel (default; kept for compatibility)")
  .option("--binary", "Update CPA binary only")
  .option("--panel", "Update management panel only")
  .option("--version <ver>", "Install specific CPA version (e.g. 7.2.66)")
  .option(
    "--force",
    "Reinstall even if already latest (running CPA is always restarted on replace)",
  )
  .option("--insecure", "Skip binary checksum verification (unsafe)")
  .action(
    withCliErrors(
      async (opts: {
        all?: boolean;
        binary?: boolean;
        panel?: boolean;
        version?: string;
        force?: boolean;
        insecure?: boolean;
      }) => {
        assertUpdateScopeFlags(opts);
        await runUpdate({
          panelOnly: !!opts.panel,
          binaryOnly: !!opts.binary,
          version: opts.version,
          force: opts.force,
          insecure: opts.insecure,
        });
      },
    ),
  );

program
  .command("doctor")
  .description("Validate the single CPA instance")
  .action(
    withCliErrors(async () => {
      await runDoctor();
    }),
  );

program
  .command("clean")
  .description("Remove old MiniCPA staging files (never touches the CPA instance)")
  .action(
    withCliErrors(async () => {
      await runClean();
    }),
  );

program
  .command("version")
  .description("Show MiniCPA and CPA runtime versions")
  .action(
    withCliErrors(async () => {
      await runVersion(pkg.version);
    }),
  );

program
  .command("home")
  .description("Print the single CPA instance directory")
  .action(
    withCliErrors(async () => {
      const ctx = createContext();
      console.log(ctx.home);
    }),
  );

program
  .command("root")
  .description("Print MiniCPA root (persistent data)")
  .action(
    withCliErrors(async () => {
      console.log(miniCpaRoot());
    }),
  );

program
  .command("temp")
  .description("Print private staging directory")
  .action(
    withCliErrors(async () => {
      console.log(miniCpaTempRoot());
    }),
  );

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
