import {
  inspectAutostartState,
  lingerHint,
  type AutostartState,
  setAutostartEnabled,
} from "../process/autostart.js";
import { withMiniCpaLock } from "../process/lock.js";
import { detectNpmGlobalInstall } from "../update/self-upgrade.js";

export type AutoMode = "on" | "off";

export type AutoCommandDependencies = {
  inspectState?: typeof inspectAutostartState;
  setEnabled?: typeof setAutostartEnabled;
  withLock?: typeof withMiniCpaLock;
  detectGlobalInstall?: typeof detectNpmGlobalInstall;
  /** Full linger-hint policy, including its Linux gating. */
  lingerHint?: typeof lingerHint;
};

const realAutoDeps: Required<AutoCommandDependencies> = {
  inspectState: inspectAutostartState,
  setEnabled: setAutostartEnabled,
  withLock: withMiniCpaLock,
  detectGlobalInstall: detectNpmGlobalInstall,
  lingerHint,
};

function nextAutostartEnabled(current: AutostartState): boolean {
  // Only a registration that is actually in force gets turned off. "stale" and
  // "disabled" entries start nothing, so a toggle repairs them: enabling
  // rewrites the launcher and clears the OS disable flag.
  return current !== "on";
}

/** Toggle automatic startup, or set it explicitly when a mode is supplied. */
export async function runAuto(
  options: { packageRoot: string; mode?: AutoMode },
  deps?: AutoCommandDependencies,
): Promise<void> {
  const d = { ...realAutoDeps, ...deps };
  const enabled = await d.withLock("auto", async () => {
    const next =
      options.mode === undefined
        ? nextAutostartEnabled(await d.inspectState())
        : options.mode === "on";

    if (next) {
      const installation = await d.detectGlobalInstall(
        options.packageRoot,
        {},
        { requireWritable: false },
      );
      if (!installation.supported) {
        throw new Error(
          [
            "Autostart requires a stable direct npm-global MiniCPA installation.",
            installation.message,
            "Install globally with:",
            "npm install -g @astralyn/minicpa@latest",
          ].join("\n"),
        );
      }
    }
    await d.setEnabled(next);
    return next;
  });
  console.log(`Autostart ${enabled ? "on" : "off"}`);
  if (!enabled) return;
  const hint = await d.lingerHint();
  if (hint) console.error(`Note: ${hint}`);
}
