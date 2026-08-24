#!/usr/bin/env node
import "./node-version-guard.js";
import { Argument, Command, CommanderError, type Help, Option } from "commander";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withCliErrors } from "./cli-errors.js";
import { runAuto } from "./commands/auto-cmd.js";
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
import { runUpgrade, runUpgradeCheck } from "./commands/upgrade-cmd.js";
import { runVersion } from "./commands/version-cmd.js";
import { createContext } from "./context.js";
import { miniCpaRoot, miniCpaTempRoot } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  version: string;
};

const program = new Command();
program
  .name("cpa")
  .description("MiniCPA — manage, run, and update one local CLIProxyAPI instance.")
  .version(pkg.version, "-v, --version", "Show the MiniCPA version")
  // Commander options accept at most two flags. Keep the third version spelling as a
  // separate hidden option, handled through its public option event below.
  .addOption(new Option("-V", "Show the MiniCPA version").hideHelp())
  .helpOption("-h, --help", "Show help")
  .showHelpAfterError(false)
  // Without this, a program-level version flag may be matched AFTER a subcommand
  // name, so `cpa update --version 7.2.66` would print MiniCPA's version instead of
  // reaching update's own `--version <ver>` pin.
  .enablePositionalOptions()
  .exitOverride();

program.on("option:V", () => {
  console.log(pkg.version);
  throw new CommanderError(0, "commander.version", pkg.version);
});

program
  .command("init")
  .description("Initialize configuration and install the latest components")
  .option("--force", "Overwrite config.yaml (backs up to config.yaml.bak.<timestamp>)")
  .action(
    withCliErrors(async (opts: { force?: boolean }) => {
      await runInit({ force: opts.force });
    }),
  );

program
  .command("start")
  .description("Start CLIProxyAPI in the background and wait until it is ready")
  .option("--no-wait", "Do not wait for CLIProxyAPI to become ready")
  .action(
    withCliErrors(async (opts: { wait?: boolean }) => {
      await runStart({ noWait: opts.wait === false });
    }),
  );

program
  .command("stop")
  .description("Stop CLIProxyAPI")
  .action(
    withCliErrors(async () => {
      await runStop();
    }),
  );

program
  .command("restart")
  .description("Restart CLIProxyAPI")
  .option("--no-wait", "Do not wait for CLIProxyAPI to become ready")
  .action(
    withCliErrors(async (opts: { wait?: boolean }) => {
      await runRestart({ noWait: opts.wait === false });
    }),
  );

program
  .command("auto")
  .description("Toggle or set CLIProxyAPI autostart for the current user")
  .addArgument(new Argument("[mode]", "Set autostart explicitly").choices(["on", "off"]))
  .action(
    withCliErrors(async (mode?: "on" | "off") => {
      await runAuto({ packageRoot, mode });
    }),
  );

program
  .command("status")
  .description("Show CLIProxyAPI runtime, autostart, and endpoints")
  .action(
    withCliErrors(async () => {
      await runStatus();
    }),
  );

program
  .command("web")
  .description("Open the web management panel")
  .action(
    withCliErrors(async () => {
      await runOpen();
    }),
  );

program
  .command("open", { hidden: true })
  .description("Open the web management panel")
  .action(
    withCliErrors(async () => {
      await runOpen();
    }),
  );

program
  .command("logs")
  .description("Show CLIProxyAPI logs (stdout and stderr by default)")
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
  .description("Open the CLIProxyAPI terminal UI")
  .action(
    withCliErrors(async () => {
      await runTui();
    }),
  );

const updateCmd = program
  .command("update")
  .description("Update the managed CLIProxyAPI binary and web management panel");

updateCmd
  .command("check")
  .description("Check CLIProxyAPI and web panel versions without installing")
  .action(
    withCliErrors(async () => {
      await runUpdateCheck();
    }),
  );

updateCmd
  .addOption(
    new Option("--all", "Update the CLIProxyAPI binary and web panel (the default)")
      .hideHelp()
      .conflicts(["binary", "panel"]),
  )
  .addOption(
    new Option("--binary", "Update only the CLIProxyAPI binary").conflicts(["all", "panel"]),
  )
  .addOption(
    new Option("--panel", "Update only the web management panel").conflicts(["all", "binary"]),
  )
  .option(
    "--version <version>",
    "Install a specific CLIProxyAPI binary version (for example, 7.2.66)",
  )
  .option("--force", "Reinstall selected components even when up to date")
  .option("--insecure", "Skip CLIProxyAPI checksum verification (unsafe)")
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

updateCmd.addHelpText(
  "after",
  [
    "",
    "Both components are updated by default.",
    "A running instance is restarted only when its CLIProxyAPI binary is replaced.",
    "To upgrade MiniCPA itself, run cpa upgrade.",
    "",
  ].join("\n"),
);

const upgradeCmd = program
  .command("upgrade")
  .description("Upgrade the globally installed MiniCPA package through npm");

upgradeCmd
  .command("check")
  .description("Check npm for a newer MiniCPA version without installing")
  .action(
    withCliErrors(async () => {
      await runUpgradeCheck(pkg.version);
    }),
  );

upgradeCmd
  .option("--force", "Reinstall the latest npm version when current (never downgrade)")
  .action(
    withCliErrors(async (opts: { force?: boolean }) => {
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
      "This command does not update, stop, or restart the managed CLIProxyAPI instance.",
      "To update CLIProxyAPI or the web panel, run cpa update.",
      "",
    ].join("\n"),
  );

program
  .command("doctor")
  .description("Diagnose CLIProxyAPI installation and runtime problems")
  .action(
    withCliErrors(async () => {
      await runDoctor();
    }),
  );

program
  .command("clean", { hidden: true })
  .description("Remove old MiniCPA staging files (never touches the CLIProxyAPI instance)")
  .action(
    withCliErrors(async () => {
      await runClean();
    }),
  );

program
  .command("version")
  .description("Show installed component versions")
  .action(
    withCliErrors(async () => {
      await runVersion(pkg.version);
    }),
  );

program
  .command("home")
  .description("Print the CLIProxyAPI instance directory")
  .action(
    withCliErrors(async () => {
      const ctx = createContext();
      console.log(ctx.home);
    }),
  );

program
  .command("root", { hidden: true })
  .description("Print MiniCPA root (persistent data)")
  .action(
    withCliErrors(async () => {
      console.log(miniCpaRoot());
    }),
  );

program
  .command("temp", { hidden: true })
  .description("Print private staging directory")
  .action(
    withCliErrors(async () => {
      console.log(miniCpaTempRoot());
    }),
  );

const rootCommandGroups = [
  { title: "Lifecycle", commands: ["init", "start", "stop", "restart", "auto", "status"] },
  { title: "Interfaces", commands: ["web", "tui", "logs"] },
  { title: "Updates", commands: ["update", "upgrade"] },
  { title: "Diagnostics", commands: ["doctor"] },
  { title: "Information", commands: ["version", "home"] },
] as const;

/** Keep the root command list concise while retaining Commander's normal help elsewhere. */
function formatRootHelp(cmd: Command, helper: Help): string {
  const termWidth = helper.padWidth(cmd, helper);
  const formatOption = (option: Option): string => {
    const term = option.long === "--version" ? "-v, -V, --version" : helper.optionTerm(option);
    return helper.formatItem(
      helper.styleOptionTerm(term),
      termWidth,
      helper.styleOptionDescription(helper.optionDescription(option)),
      helper,
    );
  };
  const formatCommand = (command: Command): string =>
    helper.formatItem(
      helper.styleSubcommandTerm(helper.subcommandTerm(command)),
      termWidth,
      helper.styleSubcommandDescription(helper.subcommandDescription(command)),
      helper,
    );

  const output = [
    `${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(cmd))}`,
    "",
    helper.boxWrap(
      helper.styleCommandDescription(helper.commandDescription(cmd)),
      helper.helpWidth ?? 80,
    ),
    "",
    helper.styleTitle("Options:"),
    ...helper.visibleOptions(cmd).map(formatOption),
    "",
  ];

  for (const group of rootCommandGroups) {
    const commands = group.commands.map((name) =>
      cmd.commands.find((item) => item.name() === name),
    );
    output.push(
      helper.styleTitle(`${group.title}:`),
      ...commands.filter((command): command is Command => command !== undefined).map(formatCommand),
      "",
    );
  }

  return output.join("\n");
}

// Configure only the root after creating the children, so command-specific help keeps
// Commander's standard renderer.
program
  .configureHelp({ formatHelp: formatRootHelp })
  // With a root action Commander treats a bare operand as an excess argument. Accept it
  // through parsing so the action can preserve the clearer "unknown command" diagnostic.
  .allowExcessArguments(true)
  .addHelpText(
    "after",
    "\nQuick start:\n  cpa init\n  cpa start\n  cpa web\n\nRun cpa <command> --help for command details.\n",
  )
  .action(() => {
    const unknownCommand = program.args[0];
    if (unknownCommand !== undefined) {
      program.error(`error: unknown command '${unknownCommand}'`, {
        code: "commander.unknownCommand",
        exitCode: 1,
      });
    }
    program.outputHelp();
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // Commander exitOverride throws on --help / unknown commands / version.
  const e = err as { code?: string; message?: string; exitCode?: number };
  if (e.code === "commander.helpDisplayed" || e.code === "commander.version") {
    // Explicit `--help` / `--version` always succeed.
    process.exitCode = 0;
  } else if (e.code === "commander.help") {
    // Commander reuses this code for both `cpa help <known-cmd>` (exitCode 0) and the
    // error path help({ error: true }) used for a missing/unknown subcommand (exitCode 1).
    process.exitCode = typeof e.exitCode === "number" ? e.exitCode : 0;
  } else {
    // Command.error() already wrote the message to stderr before exitOverride threw,
    // so re-printing a CommanderError would duplicate every usage error.
    if (!(err instanceof CommanderError) && e.message) console.error(e.message);
    process.exitCode = typeof e.exitCode === "number" ? e.exitCode : 1;
  }
}
