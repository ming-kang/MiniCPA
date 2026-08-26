import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../fs-atomic.js";
import { type CommandResult, runCommand } from "./runtime.js";

// Re-export platform-specific serialization helpers for tests.
export { windowsVbsContents } from "./autostart-windows.js";
export { launchAgentContents } from "./autostart-macos.js";
export { systemdUnitContents } from "./autostart-linux.js";
// Re-export linger hint from Linux backend for callers.
export { LINGER_HINT, lingerHint } from "./autostart-linux.js";

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
 * Write a registration file, then register it with the OS manager. Any
 * failure removes the file again.
 */
export async function registerWithRollback(
  file: string,
  contents: string,
  command: string,
  args: string[],
  deps?: AutostartDependencies,
): Promise<void> {
  writeFileAtomic(file, contents, { hardenDirectory: false });
  let result: CommandResult;
  try {
    result = await runAutostartCommand(deps, command, args);
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  if (result.code !== 0) {
    fs.rmSync(file, { force: true });
    throw commandFailure("enable", result);
  }
}

// --- Platform dispatch ---

function assertSupportedPlatform(
  platform: NodeJS.Platform,
): asserts platform is "win32" | "darwin" | "linux" {
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`Autostart is not supported on ${platform}`);
  }
}

function assertCliPath(deps?: AutostartDependencies): void {
  const cliPath = cliPathOf(deps);
  if (!fs.existsSync(cliPath)) {
    throw new Error(`MiniCPA CLI entry not found: ${cliPath}. Run npm run build and retry.`);
  }
}

/** Read the current user's effective MiniCPA autostart registration state. */
export async function inspectAutostartState(deps?: AutostartDependencies): Promise<AutostartState> {
  const platform = platformOf(deps);
  assertSupportedPlatform(platform);

  if (platform === "win32") {
    const { inspectWindowsAutostart } = await import("./autostart-windows.js");
    return inspectWindowsAutostart(deps);
  }
  if (platform === "darwin") {
    const { inspectMacAutostart } = await import("./autostart-macos.js");
    return inspectMacAutostart(deps);
  }
  const { inspectLinuxAutostart } = await import("./autostart-linux.js");
  return inspectLinuxAutostart(deps);
}

/** Set the current user's MiniCPA autostart registration. */
export async function setAutostartEnabled(
  enabled: boolean,
  deps?: AutostartDependencies,
): Promise<void> {
  const platform = platformOf(deps);
  assertSupportedPlatform(platform);
  if (enabled) assertCliPath(deps);

  if (platform === "win32") {
    const { setWindowsAutostart } = await import("./autostart-windows.js");
    await setWindowsAutostart(enabled, deps);
    return;
  }
  if (platform === "darwin") {
    const { setMacAutostart } = await import("./autostart-macos.js");
    await setMacAutostart(enabled, deps);
    return;
  }
  const { setLinuxAutostart } = await import("./autostart-linux.js");
  await setLinuxAutostart(enabled, deps);
}
