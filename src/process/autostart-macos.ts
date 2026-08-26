import fs from "node:fs";
import path from "node:path";
import type { AutostartDependencies, AutostartState } from "./autostart.js";
import {
  assertSafeLauncherValue,
  autostartVerdict,
  commandFailure,
  homeOf,
  nodePathOf,
  cliPathOf,
  registerWithRollback,
  runAutostartCommand,
  readFileIfExists,
} from "./autostart.js";

const LAUNCH_AGENT_LABEL = "com.astralyn.minicpa";
const LAUNCH_AGENT_NAME = `${LAUNCH_AGENT_LABEL}.plist`;

function launchAgentPath(deps?: AutostartDependencies): string {
  return path.join(homeOf(deps), "Library", "LaunchAgents", LAUNCH_AGENT_NAME);
}

function uidOf(deps?: AutostartDependencies): number {
  const uid = deps?.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Could not determine the current user ID for autostart");
  return uid;
}

function launchAgentDomain(deps?: AutostartDependencies): string {
  return `gui/${uidOf(deps)}`;
}

function launchAgentTarget(deps?: AutostartDependencies): string {
  return `${launchAgentDomain(deps)}/${LAUNCH_AGENT_LABEL}`;
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

/** Values `launchctl print-disabled` is known to use for an enabled service. */
const LAUNCHCTL_ENABLED_VALUES = new Set(["false", "enabled"]);

function launchctlReportsDisabled(stdout: string): boolean {
  const label = LAUNCH_AGENT_LABEL.replaceAll(".", String.raw`\.`);
  const entry = new RegExp(String.raw`"${label}"\s*=>\s*(\S+)`).exec(stdout);
  if (entry === null) return false;
  const value = (entry[1] ?? "").toLowerCase().replace(/[^a-z]+$/, "");
  return !LAUNCHCTL_ENABLED_VALUES.has(value);
}

export async function inspectMacAutostart(deps?: AutostartDependencies): Promise<AutostartState> {
  const contents = readFileIfExists(launchAgentPath(deps));
  return autostartVerdict({
    registered: contents !== undefined,
    intact: contents === launchAgentContents(nodePathOf(deps), cliPathOf(deps)),
    osDisabled: async () => {
      const result = await runAutostartCommand(deps, "launchctl", [
        "print-disabled",
        launchAgentDomain(deps),
      ]);
      if (result.code !== 0) throw commandFailure("inspect", result);
      return launchctlReportsDisabled(result.stdout);
    },
  });
}

export async function setMacAutostart(
  enabled: boolean,
  deps?: AutostartDependencies,
): Promise<void> {
  const file = launchAgentPath(deps);
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }

  await registerWithRollback(
    file,
    launchAgentContents(nodePathOf(deps), cliPathOf(deps)),
    "launchctl",
    ["enable", launchAgentTarget(deps)],
    deps,
  );
}
