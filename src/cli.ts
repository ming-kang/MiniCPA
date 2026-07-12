#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { runUpdate, runUpdateCheck } from "./commands/update-cmd.js";
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
  .option("--home <dir>", "CPA_HOME override for all commands");

program
  .command("init")
  .description("Create CPA_HOME layout and register default home")
  .option("--home <dir>", "CPA_HOME directory", defaultCpaHome())
  .option("--force", "Overwrite config.yaml")
  .action(async (opts: { home: string; force?: boolean }, cmd: Command) => {
    await runInit({ home: resolveHomeOption(cmd) ?? opts.home, force: opts.force });
  });

program
  .command("start")
  .description("Start CPA in background (waits until HTTP is ready)")
  .option("--no-wait", "Do not wait for HTTP ready")
  .action(async (opts: { wait?: boolean }, cmd: Command) => {
    // commander: --no-wait sets wait=false
    await runStart({ home: resolveHomeOption(cmd), noWait: opts.wait === false });
  });

program.command("stop").description("Stop CPA").action(async (_opts: unknown, cmd: Command) => {
  await runStop({ home: resolveHomeOption(cmd) });
});

program
  .command("restart")
  .description("Restart CPA")
  .option("--no-wait", "Do not wait for HTTP ready")
  .action(async (opts: { wait?: boolean }, cmd: Command) => {
    await runRestart({ home: resolveHomeOption(cmd), noWait: opts.wait === false });
  });

program.command("status").description("Show CPA status").action(async (_opts: unknown, cmd: Command) => {
  await runStatus({ home: resolveHomeOption(cmd) });
});

program.command("open").description("Open management UI in browser").action(async (_opts: unknown, cmd: Command) => {
  await runOpen({ home: resolveHomeOption(cmd) });
});

program
  .command("logs")
  .description("Show CPA logs (stdout + stderr by default)")
  .option("-f, --follow", "Follow log output")
  .option("-n, --lines <n>", "Number of lines per file", "80")
  .option("--err", "Show error log only")
  .action(async (opts: { follow?: boolean; lines: string; err?: boolean }, cmd: Command) => {
    await runLogs({
      home: resolveHomeOption(cmd),
      follow: opts.follow,
      lines: Number.parseInt(opts.lines, 10) || 80,
      errOnly: opts.err,
    });
  });

program.command("tui").description("Open official CPA terminal UI").action(async (_opts: unknown, cmd: Command) => {
  await runTui({ home: resolveHomeOption(cmd) });
});

const updateCmd = program
  .command("update")
  .description("Replace CPA binary and management panel (default: both)");

updateCmd.command("check").description("Check for updates").action(async (_opts: unknown, cmd: Command) => {
  await runUpdateCheck({ home: resolveHomeOption(cmd) });
});

updateCmd
  .option("--all", "Update binary and panel (default; kept for compatibility)")
  .option("--binary", "Update CPA binary only")
  .option("--panel", "Update management panel only")
  .option("--version <ver>", "Install specific CPA version (e.g. 7.2.66)")
  .option("--force", "If running: stop, replace, restart")
  .action(
    async (
      opts: { all?: boolean; binary?: boolean; panel?: boolean; version?: string; force?: boolean },
      cmd: Command,
    ) => {
      await runUpdate({
        home: resolveHomeOption(cmd),
        panelOnly: opts.panel,
        binaryOnly: opts.binary && !opts.panel && !opts.all,
        version: opts.version,
        force: opts.force,
      });
    },
  );

program.command("doctor").description("Validate CPA_HOME and runtime").action(async (_opts: unknown, cmd: Command) => {
  await runDoctor({ home: resolveHomeOption(cmd) });
});

program
  .command("version")
  .description("Show MiniCPA and CPA runtime versions")
  .action(async (_opts: unknown, cmd: Command) => {
    const ctx = createContext({ home: resolveHomeOption(cmd) });
    const state = readInstallState(ctx.home);
    const runtime = await readCurrentRuntimeVersion(ctx.home);
    console.log(`minicpa   ${pkg.version}`);
    console.log(`CPA_HOME  ${ctx.home}`);
    console.log(`cpa       ${runtime ?? "(not installed)"}`);
    console.log(`panel     ${state.panelVersion ?? "-"}`);
  });

program
  .command("home")
  .description("Print CPA instance directory (config, auths, binary)")
  .action(async (_opts: unknown, cmd: Command) => {
    const ctx = createContext({ home: resolveHomeOption(cmd) });
    console.log(ctx.home);
  });

program.command("root").description("Print MiniCPA root (persistent data)").action(() => {
  console.log(miniCpaRoot());
});

program.command("temp").description("Print MiniCPA temp dir (downloads / extract)").action(() => {
  console.log(miniCpaTempRoot());
});

await program.parseAsync(process.argv);
