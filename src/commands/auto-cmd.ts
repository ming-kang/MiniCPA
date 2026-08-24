import { isAutostartEnabled, setAutostartEnabled } from "../process/autostart.js";
import { withMiniCpaLock } from "../process/lock.js";

export type AutoCommandDependencies = {
  isEnabled?: () => Promise<boolean>;
  setEnabled?: (enabled: boolean) => Promise<void>;
  withLock?: typeof withMiniCpaLock;
};

/** Toggle automatic startup for the current user. */
export async function runAuto(deps?: AutoCommandDependencies): Promise<void> {
  const inspect = deps?.isEnabled ?? isAutostartEnabled;
  const set = deps?.setEnabled ?? setAutostartEnabled;
  const withLock = deps?.withLock ?? withMiniCpaLock;

  const enabled = await withLock("auto", async () => {
    const current = await inspect();
    await set(!current);
    return !current;
  });
  console.log(`Autostart ${enabled ? "on" : "off"}`);
}
