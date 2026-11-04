#!/usr/bin/env node
import "./node-version-guard.js";
import { Argument, Command, CommanderError, Help, Option } from "commander";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiBaseUrl, DEFAULT_API_URL } from "./api-url.js";
import { withCliErrors } from "./cli-errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  version: string;
};

/** Commands that probe or print the CPA API URL; the rest never read it. */
const API_URL_COMMANDS = new Set(["init", "start", "restart", "status", "web", "update"]);

const program = new Command();
program
  .name("cpa")
  .description("MiniCPA — manage, run, and update one local CLIProxyAPI instance.")
  .version(pkg.version, "-v, --version", "Show the MiniCPA version")
  .addOption(
    new Option("--api-url <url>", "CPA API base URL for probes and Web access")
      .default(DEFAULT_API_URL)
      .env("MINICPA_API_URL"),
  )
  .helpOption("-h, --help", "Show help")
  .helpCommand(false)
  .configureHelp({
    // Commander counts hidden options too, which would list `start [options]` for --no-wait alone.
    subcommandTerm(cmd) {
      const term = Help.prototype.subcommandTerm.call(this, cmd);
      return cmd.options.every((option) => option.hidden) ? term.replace(" [options]", "") : term;
    },
  })
  .showHelpAfterError(false)
  // Without this, a program-level version flag may be matched AFTER a subcommand
  // name, so `cpa update --version 7.2.66` would print MiniCPA's version instead of
  // reaching update's own `--version <ver>` pin.
  .enablePositionalOptions()
  .hook("preAction", (_program, actionCommand) => {
    process.env.MINICPA_API_URL = program.opts<{ apiUrl: string }>().apiUrl;
    // Reject a bad target before a command that probes or prints it changes anything.
    if (API_URL_COMMANDS.has(actionCommand.name())) apiBaseUrl();
  })
  .exitOverride();

// Autostart launchers pass --no-wait; interactive use always waits for readiness.
const noWaitOption = (): Option =>
  new Option("--no-wait", "Do not wait for CLIProxyAPI to become ready").hideHelp();

program.commandsGroup("Lifecycle:");

program
  .command("init")
  .description("Create config.yaml once and install CLIProxyAPI")
  .action(
    withCliErrors(async () => {
      const { runInit } = await import("./commands/init.js");
      await runInit();
    }),
  );

program
  .command("start")
  .description("Start CLIProxyAPI in the background")
  .addOption(noWaitOption())
  .action(
    withCliErrors(async (opts: { wait?: boolean }) => {
      const { runStart } = await import("./commands/lifecycle-cmd.js");
      await runStart({ noWait: opts.wait === false });
    }),
  );

program
  .command("stop")
  .description("Stop CLIProxyAPI")
  .action(
    withCliErrors(async () => {
      const { runStop } = await import("./commands/lifecycle-cmd.js");
      await runStop();
    }),
  );

program
  .command("restart")
  .description("Restart CLIProxyAPI")
  .addOption(noWaitOption())
  .action(
    withCliErrors(async (opts: { wait?: boolean }) => {
      const { runRestart } = await import("./commands/lifecycle-cmd.js");
      await runRestart({ noWait: opts.wait === false });
    }),
  );

program
  .command("status")
  .description("Show status, versions, endpoints, and detected problems")
  .action(
    withCliErrors(async () => {
      const { runStatus } = await import("./commands/lifecycle-cmd.js");
      await runStatus(pkg.version);
    }),
  );

program
  .command("auto")
  .description("Show or set CLIProxyAPI autostart at login")
  .addArgument(new Argument("[mode]", "Turn autostart on or off").choices(["on", "off"]))
  .action(
    withCliErrors(async (mode?: "on" | "off") => {
      const { runAuto } = await import("./commands/auto-cmd.js");
      await runAuto({ packageRoot, mode });
    }),
  );

program.commandsGroup("Interfaces:");

program
  .command("web")
  .description("Print and open the Web panel URL")
  .action(
    withCliErrors(async () => {
      const { runOpen } = await import("./commands/lifecycle-cmd.js");
      await runOpen();
    }),
  );

program
  .command("tui")
  .description("Open the CLIProxyAPI terminal UI")
  .action(
    withCliErrors(async () => {
      const { runTui } = await import("./commands/lifecycle-cmd.js");
      await runTui();
    }),
  );

program
  .command("logs")
  .description("Show CLIProxyAPI application or request-error logs")
  .option("-f, --follow", "Follow log output")
  .option("-n, --lines <n>", "Number of lines per file", "80")
  .option("--err", "Show request-error logs")
  .action(
    withCliErrors(async (opts: { follow?: boolean; lines: string; err?: boolean }) => {
      const { runLogs, parseLogLineCount } = await import("./commands/logs.js");
      await runLogs({
        follow: opts.follow,
        lines: parseLogLineCount(opts.lines),
        errOnly: opts.err,
      });
    }),
  );

program.commandsGroup("Updates:");

program
  .command("update")
  .description("Update CLIProxyAPI (restarts it only if replaced)")
  .option("--version <version>", "Install a specific CLIProxyAPI version (for example, 7.2.66)")
  .option("--force", "Reinstall even when up to date")
  .option("--insecure", "Skip checksum verification (unsafe)")
  .action(
    withCliErrors(async (opts: { version?: string; force?: boolean; insecure?: boolean }) => {
      const { runUpdate } = await import("./commands/update-cmd.js");
      await runUpdate(opts);
    }),
  )
  .addHelpText(
    "after",
    [
      "",
      "CLIProxyAPI owns its configuration and Web panel; updates never touch them.",
      "To upgrade MiniCPA itself, run cpa upgrade.",
      "",
    ].join("\n"),
  );

program
  .command("upgrade")
  .description("Upgrade MiniCPA itself through npm")
  .option("--force", "Reinstall the latest npm version when current (never downgrade)")
  .action(
    withCliErrors(async (opts: { force?: boolean }) => {
      const { runUpgrade } = await import("./commands/upgrade-cmd.js");
      await runUpgrade({
        currentVersion: pkg.version,
        packageRoot,
        force: opts.force,
      });
    }),
  )
  .addHelpText(
    "after",
    [
      "",
      "This command never stops, restarts, or updates CLIProxyAPI.",
      "To update CLIProxyAPI, run cpa update.",
      "",
    ].join("\n"),
  );

program.addHelpText(
  "after",
  "\nQuick start:\n  cpa init\n  cpa start\n  cpa web\n\nRun cpa <command> --help for command details.\n",
);

try {
  // Commander treats a bare command group as a usage error (help on stderr, exit 1).
  if (process.argv.length <= 2) program.outputHelp();
  else await program.parseAsync(process.argv);
} catch (err) {
  // Commander exitOverride throws on --help / unknown commands / version.
  const e = err as { code?: string; message?: string; exitCode?: number };
  if (e.code === "commander.helpDisplayed" || e.code === "commander.version") {
    process.exitCode = 0;
  } else {
    // Command.error() already wrote the message to stderr before exitOverride threw,
    // so re-printing a CommanderError would duplicate every usage error.
    if (!(err instanceof CommanderError) && e.message) console.error(e.message);
    process.exitCode = typeof e.exitCode === "number" ? e.exitCode : 1;
  }
}
