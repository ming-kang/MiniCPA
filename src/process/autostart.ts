import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../fs-atomic.js";
import { runCommand } from "./runtime.js";

const WINDOWS_RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
const WINDOWS_RUN_SUBKEY = String.raw`Software\Microsoft\Windows\CurrentVersion\Run`;
const WINDOWS_VALUE_NAME = "MiniCPA";
const WINDOWS_EXPECTED_ENV = "MINICPA_AUTOSTART_EXPECTED";
const LAUNCH_AGENT_NAME = "com.astralyn.minicpa.plist";
const SYSTEMD_UNIT_NAME = "minicpa.service";

type CommandRunner = typeof runCommand;

export type AutostartDependencies = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
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

function launchAgentPath(deps?: AutostartDependencies): string {
  return path.join(homeOf(deps), "Library", "LaunchAgents", LAUNCH_AGENT_NAME);
}

function linuxConfigHome(deps?: AutostartDependencies): string {
  const configured = envOf(deps).XDG_CONFIG_HOME?.trim();
  return configured && path.isAbsolute(configured)
    ? configured
    : path.join(homeOf(deps), ".config");
}

function systemdUnitPath(deps?: AutostartDependencies): string {
  return path.join(linuxConfigHome(deps), "systemd", "user", SYSTEMD_UNIT_NAME);
}

function assertSafeLauncherPath(value: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      throw new Error("Autostart launcher paths cannot contain control characters");
    }
  }
}

function windowsCommand(deps?: AutostartDependencies): string {
  const nodePath = nodePathOf(deps);
  const cliPath = cliPathOf(deps);
  assertSafeLauncherPath(nodePath);
  assertSafeLauncherPath(cliPath);
  return `"${nodePath}" "${cliPath}" start --no-wait`;
}

const WINDOWS_INSPECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop';",
  "try {",
  `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${WINDOWS_RUN_SUBKEY}');`,
  "if ($null -eq $key) { [Console]::Out.Write('absent'); exit 1 };",
  `$value = $key.GetValue('${WINDOWS_VALUE_NAME}', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);`,
  "$key.Dispose();",
  "if ($null -eq $value) { [Console]::Out.Write('absent'); exit 1 };",
  `if ([string]::Equals([string]$value, $env:${WINDOWS_EXPECTED_ENV}, [System.StringComparison]::OrdinalIgnoreCase)) { [Console]::Out.Write('enabled'); exit 0 };`,
  "[Console]::Out.Write('stale'); exit 2;",
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
  assertSafeLauncherPath(value);
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
    "  <string>com.astralyn.minicpa</string>",
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

function quoteSystemdArgument(value: string): string {
  assertSafeLauncherPath(value);
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$");
  return `"${escaped}"`;
}

/** @internal exported for focused serialization tests. */
export function systemdUnitContents(nodePath: string, cliPath: string): string {
  return [
    "[Unit]",
    "Description=Start CLIProxyAPI through MiniCPA",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
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

/** Read the current user's MiniCPA autostart switch without modifying it. */
export async function isAutostartEnabled(deps?: AutostartDependencies): Promise<boolean> {
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
    if (result.code === 0 && state === "enabled") return true;
    if ((result.code === 1 && state === "absent") || (result.code === 2 && state === "stale")) {
      return false;
    }
    throw commandFailure("inspect", result);
  }
  if (platform === "darwin") {
    const contents = readFileIfExists(launchAgentPath(deps));
    return (
      contents !== undefined && contents === launchAgentContents(nodePathOf(deps), cliPathOf(deps))
    );
  }

  const contents = readFileIfExists(systemdUnitPath(deps));
  if (contents === undefined) return false;
  if (contents !== systemdUnitContents(nodePathOf(deps), cliPathOf(deps))) return false;
  const result = await commandRunnerOf(deps)(
    "systemctl",
    ["--user", "is-enabled", SYSTEMD_UNIT_NAME],
    { env: envOf(deps), timeoutMs: 10_000 },
  );
  const state = result.stdout.trim();
  if (result.code === 0 && state === "enabled") return true;
  if (
    /^(?:enabled-runtime|disabled|masked(?:-runtime)?|not-found|static|indirect|linked(?:-runtime)?|alias|generated|transient)$/.test(
      state,
    )
  ) {
    return false;
  }
  throw commandFailure("inspect", result);
}

async function setPlatformAutostart(
  enabled: boolean,
  platform: "win32" | "darwin" | "linux",
  deps?: AutostartDependencies,
): Promise<void> {
  if (platform === "win32") {
    const args = enabled
      ? [
          "add",
          WINDOWS_RUN_KEY,
          "/v",
          WINDOWS_VALUE_NAME,
          "/t",
          "REG_SZ",
          "/d",
          windowsCommand(deps),
          "/f",
        ]
      : ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_VALUE_NAME, "/f"];
    const result = await commandRunnerOf(deps)("reg.exe", args, {
      env: envOf(deps),
      timeoutMs: 5_000,
    });
    if (result.code !== 0) throw commandFailure(enabled ? "enable" : "disable", result);
    return;
  }

  const file = platform === "darwin" ? launchAgentPath(deps) : systemdUnitPath(deps);
  if (!enabled) {
    if (platform === "linux") {
      const result = await commandRunnerOf(deps)(
        "systemctl",
        ["--user", "disable", SYSTEMD_UNIT_NAME],
        { env: envOf(deps), timeoutMs: 10_000 },
      );
      if (result.code !== 0) throw commandFailure("disable", result);
    }
    fs.rmSync(file, { force: true });
    return;
  }

  const contents =
    platform === "darwin"
      ? launchAgentContents(nodePathOf(deps), cliPathOf(deps))
      : systemdUnitContents(nodePathOf(deps), cliPathOf(deps));
  writeFileAtomic(file, contents);
  if (platform !== "linux") return;

  const result = await commandRunnerOf(deps)("systemctl", ["--user", "enable", SYSTEMD_UNIT_NAME], {
    env: envOf(deps),
    timeoutMs: 10_000,
  });
  if (result.code !== 0) {
    fs.rmSync(file, { force: true });
    throw commandFailure("enable", result);
  }
}

/** Set the current user's MiniCPA autostart switch. */
export async function setAutostartEnabled(
  enabled: boolean,
  deps?: AutostartDependencies,
): Promise<void> {
  const platform = platformOf(deps);
  assertSupportedPlatform(platform);

  if (enabled) assertCliPath(deps);
  await setPlatformAutostart(enabled, platform, deps);
}
