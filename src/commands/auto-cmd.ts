import {
  inspectAutostartState,
  type AutostartState,
  setAutostartEnabled,
} from "../process/autostart.js";
import { withMiniCpaLock } from "../process/lock.js";
import { detectNpmGlobalInstall } from "../update/self-upgrade.js";

export type AutoMode = "on" | "off";

export type AutoCommandDependencies = {
  inspectState?: () => Promise<AutostartState>;
  setEnabled?: (enabled: boolean) => Promise<void>;
  withLock?: typeof withMiniCpaLock;
  detectGlobalInstall?: typeof detectNpmGlobalInstall;
};

function nextAutostartEnabled(current: AutostartState): boolean {
  if (current === "on") return false;
  if (current === "stale") return false;
  return true;
}

/** Toggle automatic startup, or set it explicitly when a mode is supplied. */
export async function runAuto(
  options: { packageRoot: string; mode?: AutoMode },
  deps?: AutoCommandDependencies,
): Promise<void> {
  const inspect = deps?.inspectState ?? inspectAutostartState;
  const set = deps?.setEnabled ?? setAutostartEnabled;
  const withLock = deps?.withLock ?? withMiniCpaLock;
  const detectGlobalInstall = deps?.detectGlobalInstall ?? detectNpmGlobalInstall;

  const enabled = await withLock("auto", async () => {
    const next =
      options.mode === undefined ? nextAutostartEnabled(await inspect()) : options.mode === "on";

    if (next) {
      const installation = await detectGlobalInstall(
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
    await set(next);
    return next;
  });
  console.log(`Autostart ${enabled ? "on" : "off"}`);
}
