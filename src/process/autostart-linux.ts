import fs from "node:fs";
import path from "node:path";
import type { AutostartDependencies, AutostartState } from "./autostart.js";
import {
  assertSafeLauncherValue,
  autostartVerdict,
  commandFailure,
  envOf,
  homeOf,
  nodePathOf,
  cliPathOf,
  platformOf,
  registerWithRollback,
  runAutostartCommand,
  readFileIfExists,
} from "./autostart.js";

const SYSTEMD_UNIT_NAME = "minicpa.service";

/**
 * Every `systemctl --user is-enabled` answer other than `enabled` that still
 * describes a real, known unit.
 */
const SYSTEMD_INACTIVE_STATES =
  /^(?:enabled-runtime|disabled|masked(?:-runtime)?|not-found|static|indirect|linked(?:-runtime)?|alias|generated|transient)$/;

function absoluteEnvPath(value: string | undefined, fallback: string): string {
  const configured = value?.trim();
  return configured && path.isAbsolute(configured) ? configured : fallback;
}

function linuxDataHome(deps?: AutostartDependencies): string {
  return absoluteEnvPath(envOf(deps).XDG_DATA_HOME, path.join(homeOf(deps), ".local", "share"));
}

function systemdUnitPath(deps?: AutostartDependencies): string {
  return path.join(homeOf(deps), ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
}

function uidOf(deps?: AutostartDependencies): number {
  const uid = deps?.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Could not determine the current user ID for autostart");
  return uid;
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

function expectedSystemdUnit(deps?: AutostartDependencies): string {
  return systemdUnitContents(nodePathOf(deps), cliPathOf(deps), linuxDataHome(deps));
}

export async function inspectLinuxAutostart(deps?: AutostartDependencies): Promise<AutostartState> {
  const contents = readFileIfExists(systemdUnitPath(deps));
  return autostartVerdict({
    registered: contents !== undefined,
    intact: contents === expectedSystemdUnit(deps),
    osDisabled: async () => {
      const result = await runAutostartCommand(deps, "systemctl", [
        "--user",
        "is-enabled",
        SYSTEMD_UNIT_NAME,
      ]);
      const state = result.stdout.trim();
      if (result.code === 0 && state === "enabled") return false;
      if (SYSTEMD_INACTIVE_STATES.test(state)) return true;
      throw commandFailure("inspect", result);
    },
  });
}

export async function setLinuxAutostart(
  enabled: boolean,
  deps?: AutostartDependencies,
): Promise<void> {
  const file = systemdUnitPath(deps);
  if (!enabled) {
    if (readFileIfExists(file) === undefined) return;
    let failure: unknown;
    try {
      const result = await runAutostartCommand(deps, "systemctl", [
        "--user",
        "disable",
        SYSTEMD_UNIT_NAME,
      ]);
      if (result.code !== 0) failure = commandFailure("disable", result);
    } catch (err) {
      failure = err;
    }
    fs.rmSync(file, { force: true });
    if (failure !== undefined) throw failure;
    return;
  }

  await registerWithRollback(
    file,
    expectedSystemdUnit(deps),
    "systemctl",
    ["--user", "enable", file],
    deps,
  );
}

export const LINGER_HINT =
  "systemd user units start at login only — for startup without a login, run: loginctl enable-linger";

/**
 * Whether the current user's systemd units also start without a login.
 */
async function inspectLingerEnabled(deps?: AutostartDependencies): Promise<boolean | undefined> {
  if (platformOf(deps) !== "linux") return undefined;
  try {
    const result = await runAutostartCommand(deps, "loginctl", [
      "show-user",
      String(uidOf(deps)),
      "--property=Linger",
    ]);
    if (result.code !== 0) return undefined;
    const match = /^Linger=(yes|no)$/m.exec(result.stdout.trim());
    return match ? match[1] === "yes" : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hint when MiniCPA autostart is in force but systemd starts user units at
 * login only. Resolves, never rejects.
 */
export async function lingerHint(deps?: AutostartDependencies): Promise<string | undefined> {
  if (platformOf(deps) !== "linux") return undefined;
  return (await inspectLingerEnabled(deps)) === true ? undefined : LINGER_HINT;
}
