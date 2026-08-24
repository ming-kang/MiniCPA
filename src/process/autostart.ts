import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../fs-atomic.js";
import { miniCpaRoot } from "../paths.js";
import { runCommand } from "./runtime.js";

const WINDOWS_RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
const WINDOWS_VALUE_NAME = "MiniCPA";
const LAUNCH_AGENT_NAME = "com.astralyn.minicpa.plist";
const SYSTEMD_UNIT_NAME = "minicpa.service";
const AUTOSTART_RECORD_NAME = "autostart.json";

type CommandRunner = typeof runCommand;

export type AutostartDependencies = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  nodePath?: string;
  cliPath?: string;
  recordPath?: string;
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

function autostartRecordPath(deps?: AutostartDependencies): string {
  return deps?.recordPath ?? path.join(miniCpaRoot(), "state", AUTOSTART_RECORD_NAME);
}

function comparablePath(value: string, platform: NodeJS.Platform): string {
  const api = platform === "win32" ? path.win32 : path.posix;
  const resolved = api.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function autostartTargetIsCurrent(deps?: AutostartDependencies): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(autostartRecordPath(deps), "utf8")) as {
      nodePath?: unknown;
      cliPath?: unknown;
    };
    if (typeof record.nodePath !== "string" || typeof record.cliPath !== "string") return false;
    const platform = platformOf(deps);
    return (
      comparablePath(record.nodePath, platform) === comparablePath(nodePathOf(deps), platform) &&
      comparablePath(record.cliPath, platform) === comparablePath(cliPathOf(deps), platform) &&
      fs.existsSync(record.nodePath) &&
      fs.existsSync(record.cliPath)
    );
  } catch {
    return false;
  }
}

function writeAutostartRecord(deps?: AutostartDependencies): void {
  writeFileAtomic(
    autostartRecordPath(deps),
    `${JSON.stringify({ nodePath: nodePathOf(deps), cliPath: cliPathOf(deps) }, null, 2)}\n`,
  );
}

function removeAutostartRecord(deps?: AutostartDependencies): void {
  try {
    fs.rmSync(autostartRecordPath(deps), { force: true });
  } catch {
    /* stale metadata cannot enable autostart by itself */
  }
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

function windowsCommand(deps?: AutostartDependencies): string {
  return `"${nodePathOf(deps)}" "${cliPathOf(deps)}" start --no-wait`;
}

function escapeXml(value: string): string {
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
      "reg.exe",
      ["query", WINDOWS_RUN_KEY, "/v", WINDOWS_VALUE_NAME],
      { env: envOf(deps), timeoutMs: 5_000 },
    );
    return result.code === 0 && autostartTargetIsCurrent(deps);
  }
  if (platform === "darwin") {
    return fs.existsSync(launchAgentPath(deps)) && autostartTargetIsCurrent(deps);
  }

  if (!fs.existsSync(systemdUnitPath(deps))) return false;
  const result = await commandRunnerOf(deps)(
    "systemctl",
    ["--user", "is-enabled", SYSTEMD_UNIT_NAME],
    { env: envOf(deps), timeoutMs: 10_000 },
  );
  if (result.code === 0) return autostartTargetIsCurrent(deps);
  if (/^(?:disabled|masked(?:-runtime)?|not-found)$/.test(result.stdout.trim())) return false;
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

  if (!enabled) {
    await setPlatformAutostart(false, platform, deps);
    removeAutostartRecord(deps);
    return;
  }

  assertCliPath(deps);
  writeAutostartRecord(deps);
  try {
    await setPlatformAutostart(true, platform, deps);
  } catch (err) {
    removeAutostartRecord(deps);
    throw err;
  }
}
