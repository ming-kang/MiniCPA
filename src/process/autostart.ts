import fs from "node:fs";
import {
  cliPathOf,
  platformOf,
  type AutostartDependencies,
  type AutostartState,
} from "./autostart-shared.js";
export type { AutostartDependencies, AutostartState } from "./autostart-shared.js";

// --- Platform dispatch ---

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

/** Read the current user's effective MiniCPA autostart registration state. */
export async function inspectAutostartState(deps?: AutostartDependencies): Promise<AutostartState> {
  const platform = platformOf(deps);
  assertSupportedPlatform(platform);

  if (platform === "win32") {
    const { inspectWindowsAutostart } = await import("./autostart-windows.js");
    return inspectWindowsAutostart(deps);
  }
  if (platform === "darwin") {
    const { inspectMacAutostart } = await import("./autostart-macos.js");
    return inspectMacAutostart(deps);
  }
  const { inspectLinuxAutostart } = await import("./autostart-linux.js");
  return inspectLinuxAutostart(deps);
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
    const { setWindowsAutostart } = await import("./autostart-windows.js");
    await setWindowsAutostart(enabled, deps);
    return;
  }
  if (platform === "darwin") {
    const { setMacAutostart } = await import("./autostart-macos.js");
    await setMacAutostart(enabled, deps);
    return;
  }
  const { setLinuxAutostart } = await import("./autostart-linux.js");
  await setLinuxAutostart(enabled, deps);
}
