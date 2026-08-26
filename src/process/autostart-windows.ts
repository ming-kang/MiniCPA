import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../fs-atomic.js";
import type { AutostartDependencies, AutostartState } from "./autostart.js";
import {
  assertSafeLauncherValue,
  autostartVerdict,
  commandFailure,
  envOf,
  homeOf,
  nodePathOf,
  cliPathOf,
  runAutostartCommand,
} from "./autostart.js";

const WINDOWS_RUN_SUBKEY = String.raw`Software\Microsoft\Windows\CurrentVersion\Run`;
const WINDOWS_APPROVAL_SUBKEY = String.raw`Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`;
const WINDOWS_VALUE_NAME = "MiniCPA";
const WINDOWS_EXPECTED_ENV = "MINICPA_AUTOSTART_EXPECTED";
const WINDOWS_MODE_ENV = "MINICPA_AUTOSTART_MODE";
const WINDOWS_VBS_FILENAME = "minicpa-autostart.vbs";

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
  "$runB64 = if ($null -eq $runValue) { $null } else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$runValue)) };",
  "$approvalB64 = if (($approval -is [byte[]]) -and $approval.Length -gt 0) { [Convert]::ToBase64String($approval) } else { $null };",
  `[Console]::Out.Write((ConvertTo-Json ([ordered]@{ run = $runB64; approval = $approvalB64 }) -Compress)); exit 0`,
  "} catch { [Console]::Error.Write($_.Exception.Message); exit 3 }",
].join(" ");

/**
 * Registry facts reported by the Windows inspect script. Both fields are base64
 * and always present — `ConvertTo-Json` emits explicit nulls — so absence is
 * spelled `null` rather than a missing key.
 */
type WindowsRegistryFacts = { run: string | null; approval: string | null };

function isWindowsRegistryFacts(value: unknown): value is WindowsRegistryFacts {
  if (typeof value !== "object" || value === null) return false;
  const { run, approval } = value as Record<string, unknown>;
  return (
    (run === null || typeof run === "string") && (approval === null || typeof approval === "string")
  );
}

function decodeBase64Utf8(value: string | null): string | null {
  return value ? Buffer.from(value, "base64").toString("utf8") : null;
}

function parseWindowsRegistryFacts(result: {
  code: number;
  stdout: string;
  stderr: string;
}): WindowsRegistryFacts {
  let facts: unknown;
  try {
    facts = JSON.parse(result.stdout);
  } catch {
    throw commandFailure("inspect", result);
  }
  if (!isWindowsRegistryFacts(facts)) throw commandFailure("inspect", result);
  return facts;
}

function windowsWscriptPath(deps?: AutostartDependencies): string {
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

/**
 * Read the generated Windows launcher back as comparable text.
 */
function readWindowsLauncher(deps?: AutostartDependencies): string | undefined {
  const raw = readFileBytesIfExists(windowsVbsPath(deps));
  if (raw === undefined) return undefined;
  const text = raw.toString("utf16le");
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

function readFileBytesIfExists(file: string): Buffer | undefined {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function inspectWindowsAutostart(
  deps?: AutostartDependencies,
): Promise<AutostartState> {
  const result = await runAutostartCommand(deps, "powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_INSPECT_SCRIPT,
  ]);
  if (result.code !== 0) throw commandFailure("inspect", result);
  const facts = parseWindowsRegistryFacts(result);
  const runValue = decodeBase64Utf8(facts.run);
  const approvalByte = facts.approval ? (Buffer.from(facts.approval, "base64")[0] ?? 0) : 0;
  return autostartVerdict({
    registered: runValue !== null,
    intact:
      runValue !== null &&
      runValue.toLowerCase() === windowsLauncherCommand(deps).toLowerCase() &&
      readWindowsLauncher(deps) === windowsVbsContents(nodePathOf(deps), cliPathOf(deps)),
    osDisabled: async () => (approvalByte & 1) === 1,
  });
}

export async function setWindowsAutostart(
  enabled: boolean,
  deps?: AutostartDependencies,
): Promise<void> {
  const vbsPath = windowsVbsPath(deps);
  if (enabled) writeWindowsLauncher(deps);
  const result = await runAutostartCommand(
    deps,
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SET_SCRIPT],
    {
      [WINDOWS_MODE_ENV]: enabled ? "on" : "off",
      ...(enabled ? { [WINDOWS_EXPECTED_ENV]: windowsLauncherCommand(deps) } : {}),
    },
  );
  if (result.code !== 0) {
    if (enabled) {
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
