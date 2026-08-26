import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../fs-atomic.js";
import { type CommandResult, runCommand } from "./runtime.js";

const WINDOWS_RUN_SUBKEY = String.raw`Software\Microsoft\Windows\CurrentVersion\Run`;
const WINDOWS_APPROVAL_SUBKEY = String.raw`Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`;
const WINDOWS_VALUE_NAME = "MiniCPA";
const WINDOWS_EXPECTED_ENV = "MINICPA_AUTOSTART_EXPECTED";
const WINDOWS_MODE_ENV = "MINICPA_AUTOSTART_MODE";
const WINDOWS_VBS_FILENAME = "minicpa-autostart.vbs";
const WINDOWS_VBS_PATH_ENV = "MINICPA_AUTOSTART_VBS_PATH";
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

function windowsWscriptPath(deps?: AutostartDependencies): string {
  // Run-key values are parsed as a command line by the shell, so a fully
  // qualified wscript.exe is unambiguous regardless of PATH order.
  const systemRoot = envOf(deps).SystemRoot?.trim();
  const base = systemRoot && path.isAbsolute(systemRoot) ? systemRoot : "C:\\Windows";
  return path.join(base, "System32", "wscript.exe");
}

function windowsVbsPath(deps?: AutostartDependencies): string {
  const localAppData = envOf(deps).LOCALAPPDATA?.trim();
  const base =
    localAppData && path.isAbsolute(localAppData)
      ? localAppData
      : path.join(homeOf(deps), "AppData", "Local");
  return path.join(base, "MiniCPA", WINDOWS_VBS_FILENAME);
}

function windowsLauncherCommand(deps?: AutostartDependencies): string {
  const wscript = windowsWscriptPath(deps);
  const vbsPath = windowsVbsPath(deps);
  assertSafeLauncherValue(wscript);
  assertSafeLauncherValue(vbsPath);
  return `"${wscript}" "${vbsPath}"`;
}

/** @internal exported for focused serialization tests. */
export function windowsVbsContents(nodePath: string, cliPath: string): string {
  assertSafeLauncherValue(nodePath);
  assertSafeLauncherValue(cliPath);
  // VBScript string literals escape `"` by doubling it. wscript.exe parses a
  // .vbs as the ANSI codepage unless it is UTF-16 with a BOM, so the file is
  // written as UTF-16LE + BOM to keep non-ANSI paths (e.g. non-ASCII user
  // names) intact.
  const command = `"${nodePath}" "${cliPath}" start --no-wait`;
  return [
    "' MiniCPA login autostart launcher (generated by cpa auto; do not edit)",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${command.replaceAll('"', '""')}", 0, False`,
    "",
  ].join("\r\n");
}

function writeWindowsLauncher(deps?: AutostartDependencies): string {
  const vbsPath = windowsVbsPath(deps);
  const contents = `\uFEFF${windowsVbsContents(nodePathOf(deps), cliPathOf(deps))}`;
  writeFileAtomic(vbsPath, Buffer.from(contents, "utf16le"));
  return vbsPath;
}

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

// The inspect script only reports facts (Run value, StartupApproved bytes,
// launcher file contents) as UTF-8 base64 inside a compressed JSON object.
// TypeScript owns every verdict, so the decision logic stays unit-testable
// without spawning PowerShell and no OEM-codepage mangling can reach it.
const WINDOWS_INSPECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop';",
  "try {",
  `$runKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${WINDOWS_RUN_SUBKEY}');`,
  "$runValue = $null;",
  "if ($null -ne $runKey) {",
  `$runValue = $runKey.GetValue('${WINDOWS_VALUE_NAME}', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);`,
  "$runKey.Dispose();",
  "};",
  `$approvalKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${WINDOWS_APPROVAL_SUBKEY}');`,
  "$approval = $null;",
  "if ($null -ne $approvalKey) {",
  `$approval = $approvalKey.GetValue('${WINDOWS_VALUE_NAME}');`,
  "$approvalKey.Dispose();",
  "};",
  "$vbs = $null;",
  `if (Test-Path -LiteralPath $env:${WINDOWS_VBS_PATH_ENV}) { $vbs = Get-Content -Raw -LiteralPath $env:${WINDOWS_VBS_PATH_ENV} };`,
  "$runB64 = if ($null -eq $runValue) { $null } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$runValue)) };",
  "$approvalB64 = if (($approval -is [byte[]]) -and $approval.Length -gt 0) { [Convert]::ToBase64String($approval) } else { $null };",
  "$vbsB64 = if ($null -eq $vbs) { $null } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$vbs)) };",
  `[Console]::Out.Write((ConvertTo-Json ([ordered]@{ run = $runB64; approval = $approvalB64; vbs = $vbsB64 }) -Compress)); exit 0`,
  "} catch { [Console]::Error.Write($_.Exception.Message); exit 3 }",
].join(" ");

/** Facts reported by the Windows inspect script; string fields are UTF-8 base64. */
type WindowsInspectFacts = {
  run?: string | null;
  approval?: string | null;
  vbs?: string | null;
};

function decodeBase64Utf8(value: string | null | undefined): string | null {
  return value ? Buffer.from(value, "base64").toString("utf8") : null;
}

function equalsIgnoringCase(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Derive the registration state from reported facts, mirroring how Windows
 * starts the entry: an absent Run value is off; any divergence between the
 * recorded command or launcher contents and what MiniCPA generates is stale;
 * the OS StartupApproved bit outranks everything except staleness.
 */
function windowsStateFromFacts(
  facts: WindowsInspectFacts,
  deps?: AutostartDependencies,
): AutostartState {
  const runValue = decodeBase64Utf8(facts.run);
  // No Run entry means nothing would start at login.
  if (runValue === null) return "off";
  // A different command points at another (or a moved) installation.
  if (!equalsIgnoringCase(runValue, windowsLauncherCommand(deps))) return "stale";
  const approvalBytes = facts.approval ? Buffer.from(facts.approval, "base64") : undefined;
  // StartupApproved's first byte has bit 0 set when the user disabled the entry.
  const approvalByte = approvalBytes?.[0] ?? 0;
  if ((approvalByte & 1) === 1) {
    return "disabled";
  }
  const vbsContents = decodeBase64Utf8(facts.vbs);
  // A missing or rewritten launcher cannot be trusted to start MiniCPA.
  if (
    vbsContents === null ||
    vbsContents !== windowsVbsContents(nodePathOf(deps), cliPathOf(deps))
  ) {
    return "stale";
  }
  return "on";
}

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

function commandFailure(action: string, result: CommandResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`Failed to ${action} autostart: ${detail}`);
}

/**
 * Write a registration file, then register it with the OS manager. Any
 * failure removes the file again, so a failed enable never leaves behind a
 * plist or unit that inspection would report as stale.
 */
async function writeFileAndRegister(
  file: string,
  contents: string,
  action: string,
  register: () => Promise<CommandResult>,
): Promise<void> {
  writeFileAtomic(file, contents, { hardenDirectory: false });
  let result: CommandResult;
  try {
    result = await register();
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw err;
  }
  if (result.code !== 0) {
    fs.rmSync(file, { force: true });
    throw commandFailure(action, result);
  }
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
        env: {
          ...envOf(deps),
          [WINDOWS_VBS_PATH_ENV]: windowsVbsPath(deps),
        },
        timeoutMs: 10_000,
      },
    );
    if (result.code !== 0) throw commandFailure("inspect", result);
    let facts: WindowsInspectFacts;
    try {
      facts = JSON.parse(result.stdout) as WindowsInspectFacts;
    } catch {
      throw commandFailure("inspect", result);
    }
    return windowsStateFromFacts(facts, deps);
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

const LINGER_HINT =
  "systemd user units start at login only — for startup without a login, run: loginctl enable-linger";

/**
 * Hint when MiniCPA autostart is in force but systemd starts user units at
 * login only, so a headless machine also needs `loginctl enable-linger`.
 *
 * This is the single owner of that policy: only Linux registrations get a
 * hint, and an undeterminable probe (no loginctl, no user record, spawn
 * failure) still hints because silence could hide a headless gap. Resolves,
 * never rejects.
 */
export async function lingerHint(deps?: AutostartDependencies): Promise<string | undefined> {
  if (platformOf(deps) !== "linux") return undefined;
  let linger: boolean | undefined;
  try {
    linger = await inspectLingerEnabled(deps);
  } catch {
    linger = undefined;
  }
  return linger === true ? undefined : LINGER_HINT;
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
  const vbsPath = windowsVbsPath(deps);
  // Write the launcher before the Run value: a crash in between leaves an inert
  // orphan file, never a Run value pointing at a missing launcher.
  if (enabled) writeWindowsLauncher(deps);
  const result = await commandRunnerOf(deps)(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SET_SCRIPT],
    {
      env: {
        ...envOf(deps),
        [WINDOWS_MODE_ENV]: enabled ? "on" : "off",
        ...(enabled ? { [WINDOWS_EXPECTED_ENV]: windowsLauncherCommand(deps) } : {}),
      },
      timeoutMs: 10_000,
    },
  );
  if (result.code !== 0) {
    if (enabled) {
      // Best-effort rollback, mirroring the LaunchAgent/systemd cleanup.
      try {
        fs.rmSync(vbsPath, { force: true });
      } catch {
        /* leftover launcher is inert without the Run value */
      }
    }
    throw commandFailure(enabled ? "enable" : "disable", result);
  }
  if (!enabled) {
    try {
      fs.rmSync(vbsPath, { force: true });
    } catch {
      /* the Run value is already gone; a leftover launcher cannot start again */
    }
  }
}

async function setMacAutostart(enabled: boolean, deps?: AutostartDependencies): Promise<void> {
  const file = launchAgentPath(deps);
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }

  await writeFileAndRegister(
    file,
    launchAgentContents(nodePathOf(deps), cliPathOf(deps)),
    "enable",
    () =>
      commandRunnerOf(deps)("launchctl", ["enable", launchAgentTarget(deps)], {
        env: envOf(deps),
        timeoutMs: 10_000,
      }),
  );
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

  await writeFileAndRegister(file, expectedSystemdUnit(deps), "enable", () =>
    commandRunnerOf(deps)("systemctl", ["--user", "enable", file], {
      env: envOf(deps),
      timeoutMs: 10_000,
    }),
  );
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
