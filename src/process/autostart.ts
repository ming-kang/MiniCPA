import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../fs-atomic.js";
import { runCommand } from "./runtime.js";

const WINDOWS_RUN_SUBKEY = String.raw`Software\Microsoft\Windows\CurrentVersion\Run`;
const WINDOWS_APPROVAL_SUBKEY = String.raw`Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`;
const WINDOWS_VALUE_NAME = "MiniCPA";
const WINDOWS_EXPECTED_ENV = "MINICPA_AUTOSTART_EXPECTED";
const WINDOWS_MODE_ENV = "MINICPA_AUTOSTART_MODE";
const LAUNCH_AGENT_LABEL = "com.astralyn.minicpa";
const LAUNCH_AGENT_NAME = `${LAUNCH_AGENT_LABEL}.plist`;
const SYSTEMD_UNIT_NAME = "minicpa.service";

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

function platformOf(deps?: AutostartDependencies): NodeJS.Platform {
  return deps?.platform ?? process.platform;
}

function homeOf(deps?: AutostartDependencies): string {
  return deps?.homedir ?? os.homedir();
}

function envOf(deps?: AutostartDependencies): NodeJS.ProcessEnv {
  return deps?.env ?? process.env;
}

function nodePathOf(deps?: AutostartDependencies): string {
  return deps?.nodePath ?? process.execPath;
}

function cliPathOf(deps?: AutostartDependencies): string {
  if (deps?.cliPath) return deps.cliPath;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, "..", "..", "dist", "cli.js");
}

function commandRunnerOf(deps?: AutostartDependencies): CommandRunner {
  return deps?.runCommand ?? runCommand;
}

function uidOf(deps?: AutostartDependencies): number {
  const uid = deps?.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Could not determine the current user ID for autostart");
  return uid;
}

function launchAgentPath(deps?: AutostartDependencies): string {
  return path.join(homeOf(deps), "Library", "LaunchAgents", LAUNCH_AGENT_NAME);
}

function launchAgentDomain(deps?: AutostartDependencies): string {
  return `gui/${uidOf(deps)}`;
}

function launchAgentTarget(deps?: AutostartDependencies): string {
  return `${launchAgentDomain(deps)}/${LAUNCH_AGENT_LABEL}`;
}

function absoluteEnvPath(value: string | undefined, fallback: string): string {
  const configured = value?.trim();
  return configured && path.isAbsolute(configured) ? configured : fallback;
}

function linuxDataHome(deps?: AutostartDependencies): string {
  return absoluteEnvPath(envOf(deps).XDG_DATA_HOME, path.join(homeOf(deps), ".local", "share"));
}

function systemdUnitPath(deps?: AutostartDependencies): string {
  // Keep the managed source at one stable path. `systemctl enable <absolute path>`
  // links it into a user manager that uses a different XDG_CONFIG_HOME.
  return path.join(homeOf(deps), ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
}

function assertSafeLauncherValue(value: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      throw new Error("Autostart launcher values cannot contain control characters");
    }
  }
}

function windowsCommand(deps?: AutostartDependencies): string {
  const nodePath = nodePathOf(deps);
  const cliPath = cliPathOf(deps);
  assertSafeLauncherValue(nodePath);
  assertSafeLauncherValue(cliPath);
  return `"${nodePath}" "${cliPath}" start --no-wait`;
}

const WINDOWS_INSPECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop';",
  "try {",
  `$runKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${WINDOWS_RUN_SUBKEY}');`,
  "if ($null -eq $runKey) { [Console]::Out.Write('off'); exit 1 };",
  `$value = $runKey.GetValue('${WINDOWS_VALUE_NAME}', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);`,
  "$runKey.Dispose();",
  "if ($null -eq $value) { [Console]::Out.Write('off'); exit 1 };",
  `if (-not [string]::Equals([string]$value, $env:${WINDOWS_EXPECTED_ENV}, [System.StringComparison]::OrdinalIgnoreCase)) { [Console]::Out.Write('stale'); exit 2 };`,
  `$approvalKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${WINDOWS_APPROVAL_SUBKEY}');`,
  "$approval = $null;",
  `if ($null -ne $approvalKey) { $approval = $approvalKey.GetValue('${WINDOWS_VALUE_NAME}'); $approvalKey.Dispose() };`,
  "if (($approval -is [byte[]]) -and $approval.Length -gt 0 -and (($approval[0] -band 1) -eq 1)) { [Console]::Out.Write('disabled'); exit 4 };",
  "[Console]::Out.Write('on'); exit 0;",
  "} catch { [Console]::Error.Write($_.Exception.Message); exit 3 }",
].join(" ");

const WINDOWS_SET_SCRIPT = [
  "$ErrorActionPreference = 'Stop';",
  "try {",
  `$mode = $env:${WINDOWS_MODE_ENV};`,
  "if ($mode -eq 'on') {",
  `$runKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${WINDOWS_RUN_SUBKEY}');`,
  `$runKey.SetValue('${WINDOWS_VALUE_NAME}', $env:${WINDOWS_EXPECTED_ENV}, [Microsoft.Win32.RegistryValueKind]::String);`,
  "$runKey.Dispose();",
  "} elseif ($mode -eq 'off') {",
  `$runKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${WINDOWS_RUN_SUBKEY}', $true);`,
  `if ($null -ne $runKey) { $runKey.DeleteValue('${WINDOWS_VALUE_NAME}', $false); $runKey.Dispose() };`,
  "} else { throw 'Invalid autostart mode' };",
  `$approvalKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${WINDOWS_APPROVAL_SUBKEY}', $true);`,
  `if ($null -ne $approvalKey) { $approvalKey.DeleteValue('${WINDOWS_VALUE_NAME}', $false); $approvalKey.Dispose() };`,
  "exit 0;",
  "} catch { [Console]::Error.Write($_.Exception.Message); exit 3 }",
].join(" ");

function readFileIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function escapeXml(value: string): string {
  assertSafeLauncherValue(value);
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** @internal exported for focused serialization tests. */
export function launchAgentContents(nodePath: string, cliPath: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCH_AGENT_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${escapeXml(nodePath)}</string>`,
    `    <string>${escapeXml(cliPath)}</string>`,
    "    <string>start</string>",
    "    <string>--no-wait</string>",
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <false/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function quoteSystemdValue(value: string, escapeDollar: boolean): string {
  assertSafeLauncherValue(value);
  let escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (escapeDollar) escaped = escaped.replaceAll("$", () => "$$");
  return `"${escaped}"`;
}

function quoteSystemdArgument(value: string): string {
  return quoteSystemdValue(value, true);
}

function quoteSystemdEnvironment(name: string, value: string): string {
  return quoteSystemdValue(`${name}=${value}`, false);
}

/** @internal exported for focused serialization tests. */
export function systemdUnitContents(nodePath: string, cliPath: string, dataHome: string): string {
  return [
    "[Unit]",
    "Description=Start CLIProxyAPI through MiniCPA",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `Environment=${quoteSystemdEnvironment("XDG_DATA_HOME", dataHome)}`,
    `ExecStart=${quoteSystemdArgument(nodePath)} ${quoteSystemdArgument(cliPath)} start --no-wait`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

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

function commandFailure(action: string, result: Awaited<ReturnType<CommandRunner>>): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`Failed to ${action} autostart: ${detail}`);
}

function launchctlReportsDisabled(stdout: string): boolean {
  // Derive the pattern from the label constant: a hardcoded spelling would
  // silently stop matching if LAUNCH_AGENT_LABEL ever changed.
  const label = LAUNCH_AGENT_LABEL.replaceAll(".", String.raw`\.`);
  return new RegExp(String.raw`"${label}"\s*=>\s*true\b`).test(stdout);
}

function expectedSystemdUnit(deps?: AutostartDependencies): string {
  return systemdUnitContents(nodePathOf(deps), cliPathOf(deps), linuxDataHome(deps));
}

/** Read the current user's effective MiniCPA autostart registration state. */
export async function inspectAutostartState(deps?: AutostartDependencies): Promise<AutostartState> {
  const platform = platformOf(deps);
  assertSupportedPlatform(platform);

  if (platform === "win32") {
    const result = await commandRunnerOf(deps)(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_INSPECT_SCRIPT],
      {
        env: { ...envOf(deps), [WINDOWS_EXPECTED_ENV]: windowsCommand(deps) },
        timeoutMs: 10_000,
      },
    );
    const state = result.stdout.trim();
    if (result.code === 0 && state === "on") return "on";
    if (result.code === 1 && state === "off") return "off";
    if (result.code === 2 && state === "stale") return "stale";
    if (result.code === 4 && state === "disabled") return "disabled";
    throw commandFailure("inspect", result);
  }

  if (platform === "darwin") {
    const contents = readFileIfExists(launchAgentPath(deps));
    if (contents === undefined) return "off";
    if (contents !== launchAgentContents(nodePathOf(deps), cliPathOf(deps))) return "stale";
    const result = await commandRunnerOf(deps)(
      "launchctl",
      ["print-disabled", launchAgentDomain(deps)],
      { env: envOf(deps), timeoutMs: 10_000 },
    );
    if (result.code !== 0) throw commandFailure("inspect", result);
    return launchctlReportsDisabled(result.stdout) ? "disabled" : "on";
  }

  const contents = readFileIfExists(systemdUnitPath(deps));
  if (contents === undefined) return "off";
  if (contents !== expectedSystemdUnit(deps)) return "stale";
  const result = await commandRunnerOf(deps)(
    "systemctl",
    ["--user", "is-enabled", SYSTEMD_UNIT_NAME],
    { env: envOf(deps), timeoutMs: 10_000 },
  );
  const state = result.stdout.trim();
  if (result.code === 0 && state === "enabled") return "on";
  if (
    /^(?:enabled-runtime|disabled|masked(?:-runtime)?|not-found|static|indirect|linked(?:-runtime)?|alias|generated|transient)$/.test(
      state,
    )
  ) {
    return "disabled";
  }
  throw commandFailure("inspect", result);
}

/**
 * Whether the current user's systemd units also start without a login.
 *
 * A `WantedBy=default.target` user unit runs at login, so a headless machine
 * needs `loginctl enable-linger`. Returns undefined when the answer cannot be
 * determined — non-Linux, no loginctl, or a user with no session record.
 */
export async function inspectLingerEnabled(
  deps?: AutostartDependencies,
): Promise<boolean | undefined> {
  if (platformOf(deps) !== "linux") return undefined;
  try {
    const result = await commandRunnerOf(deps)(
      "loginctl",
      ["show-user", String(uidOf(deps)), "--property=Linger"],
      { env: envOf(deps), timeoutMs: 10_000 },
    );
    if (result.code !== 0) return undefined;
    const match = /^Linger=(yes|no)$/m.exec(result.stdout.trim());
    return match ? match[1] === "yes" : undefined;
  } catch {
    return undefined;
  }
}

async function setWindowsAutostart(enabled: boolean, deps?: AutostartDependencies): Promise<void> {
  const result = await commandRunnerOf(deps)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SET_SCRIPT],
    {
      env: {
        ...envOf(deps),
        [WINDOWS_MODE_ENV]: enabled ? "on" : "off",
        ...(enabled ? { [WINDOWS_EXPECTED_ENV]: windowsCommand(deps) } : {}),
      },
      timeoutMs: 10_000,
    },
  );
  if (result.code !== 0) throw commandFailure(enabled ? "enable" : "disable", result);
}

async function setMacAutostart(enabled: boolean, deps?: AutostartDependencies): Promise<void> {
  const file = launchAgentPath(deps);
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }

  writeFileAtomic(file, launchAgentContents(nodePathOf(deps), cliPathOf(deps)), {
    hardenDirectory: false,
  });
  let result: Awaited<ReturnType<CommandRunner>>;
  try {
    result = await commandRunnerOf(deps)("launchctl", ["enable", launchAgentTarget(deps)], {
      env: envOf(deps),
      timeoutMs: 10_000,
    });
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  if (result.code !== 0) {
    fs.rmSync(file, { force: true });
    throw commandFailure("enable", result);
  }
}

async function setLinuxAutostart(enabled: boolean, deps?: AutostartDependencies): Promise<void> {
  const file = systemdUnitPath(deps);
  if (!enabled) {
    if (readFileIfExists(file) === undefined) return;
    let failure: unknown;
    try {
      const result = await commandRunnerOf(deps)(
        "systemctl",
        ["--user", "disable", SYSTEMD_UNIT_NAME],
        { env: envOf(deps), timeoutMs: 10_000 },
      );
      if (result.code !== 0) failure = commandFailure("disable", result);
    } catch (err) {
      failure = err;
    }
    fs.rmSync(file, { force: true });
    if (failure !== undefined) throw failure;
    return;
  }

  writeFileAtomic(file, expectedSystemdUnit(deps), { hardenDirectory: false });
  let result: Awaited<ReturnType<CommandRunner>>;
  try {
    result = await commandRunnerOf(deps)("systemctl", ["--user", "enable", file], {
      env: envOf(deps),
      timeoutMs: 10_000,
    });
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  if (result.code !== 0) {
    fs.rmSync(file, { force: true });
    throw commandFailure("enable", result);
  }
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
    await setWindowsAutostart(enabled, deps);
    return;
  }
  if (platform === "darwin") {
    await setMacAutostart(enabled, deps);
    return;
  }
  await setLinuxAutostart(enabled, deps);
}
