import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../fs-atomic.js";
import { type CommandResult, runCommand } from "./runtime.js";

const AUTOSTART_COMMAND_TIMEOUT_MS = 10_000;

export type AutostartState = "on" | "off" | "stale" | "disabled";

type CommandRunner = typeof runCommand;

export type AutostartDependencies = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  uid?: number;
  nodePath?: string;
  cliPath?: string;
  runCommand?: CommandRunner;
};

// --- Shared helpers exported for platform backends ---

export function platformOf(deps?: AutostartDependencies): NodeJS.Platform {
  return deps?.platform ?? process.platform;
}

export function homeOf(deps?: AutostartDependencies): string {
  return deps?.homedir ?? os.homedir();
}

export function envOf(deps?: AutostartDependencies): NodeJS.ProcessEnv {
  return deps?.env ?? process.env;
}

export function nodePathOf(deps?: AutostartDependencies): string {
  return deps?.nodePath ?? process.execPath;
}

export function cliPathOf(deps?: AutostartDependencies): string {
  if (deps?.cliPath) return deps.cliPath;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "..", "..", "dist", "cli.js");
}

function commandRunnerOf(deps?: AutostartDependencies): CommandRunner {
  return deps?.runCommand ?? runCommand;
}

export function assertSafeLauncherValue(value: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      throw new Error("Autostart launcher values cannot contain control characters");
    }
  }
}

export function commandFailure(action: string, result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`Failed to ${action} autostart: ${detail}`);
}

/**
 * Run an OS autostart manager command with shared environment and timeout.
 */
export function runAutostartCommand(
  deps: AutostartDependencies | undefined,
  command: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return commandRunnerOf(deps)(command, args, {
    env: { ...envOf(deps), ...extraEnv },
    timeoutMs: AUTOSTART_COMMAND_TIMEOUT_MS,
  });
}

/**
 * Derive a registration state from platform-specific signals.
 */
export async function autostartVerdict(registration: {
  registered: boolean;
  intact: boolean;
  osDisabled: () => Promise<boolean>;
}): Promise<AutostartState> {
  if (!registration.registered) return "off";
  if (!registration.intact) return "stale";
  return (await registration.osDisabled()) ? "disabled" : "on";
}

export function readFileIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Publish a registration file, then register it with the OS manager. A failure
 * restores the previous registration, or removes a newly created file.
 */
export async function registerWithRollback(
  file: string,
  contents: string,
  command: string,
  args: string[],
  deps?: AutostartDependencies,
): Promise<void> {
  await withRegistrationFile(file, contents, async () => {
    const result = await runAutostartCommand(deps, command, args);
    if (result.code !== 0) throw commandFailure("enable", result);
  });
}

/** Publish a launcher and restore its exact previous bytes if OS registration fails. */
export async function withRegistrationFile(
  file: string,
  contents: string | Buffer,
  register: () => Promise<void>,
): Promise<void> {
  let previous: { bytes: Buffer; mode: number } | undefined;
  try {
    previous = { bytes: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    writeFileAtomic(file, contents, { hardenDirectory: false });
    await register();
  } catch (error) {
    try {
      if (previous)
        writeFileAtomic(file, previous.bytes, { mode: previous.mode, hardenDirectory: false });
      else fs.rmSync(file, { force: true });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `${String(error)}; could not restore autostart registration: ${String(rollbackError)}`,
      );
    }
    throw error;
  }
}
