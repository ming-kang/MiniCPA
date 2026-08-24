import { isAutostartEnabled, setAutostartEnabled } from "../process/autostart.js";
import { withMiniCpaLock } from "../process/lock.js";
import { detectNpmGlobalInstall } from "../update/self-upgrade.js";

export type AutoCommandDependencies = {
  isEnabled?: () => Promise<boolean>;
  setEnabled?: (enabled: boolean) => Promise<void>;
  withLock?: typeof withMiniCpaLock;
  detectGlobalInstall?: typeof detectNpmGlobalInstall;
};

/** Toggle automatic startup for the current user. */
export async function runAuto(
  options: { packageRoot: string },
  deps?: AutoCommandDependencies,
): Promise<void> {
  const inspect = deps?.isEnabled ?? isAutostartEnabled;
  const set = deps?.setEnabled ?? setAutostartEnabled;
  const withLock = deps?.withLock ?? withMiniCpaLock;
  const detectGlobalInstall = deps?.detectGlobalInstall ?? detectNpmGlobalInstall;

  const enabled = await withLock("auto", async () => {
    const current = await inspect();
    if (!current) {
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
    await set(!current);
    return !current;
  });
  console.log(`Autostart ${enabled ? "on" : "off"}`);
}
