import fs from "node:fs";
import { createContext } from "../context.js";
import {
  inspectAutostartState,
  lingerHint,
  type AutostartState,
  setAutostartEnabled,
} from "../process/autostart.js";
import { withMiniCpaLock } from "../process/lock.js";
import { inspectRunnableExecutable } from "../process/runtime.js";
import { detectNpmGlobalInstall } from "../update/self-upgrade.js";

export type AutoMode = "on" | "off";

export type AutoCommandDependencies = {
  inspectState?: typeof inspectAutostartState;
  setEnabled?: typeof setAutostartEnabled;
  withLock?: typeof withMiniCpaLock;
  detectGlobalInstall?: typeof detectNpmGlobalInstall;
  /** Full linger-hint policy, including its Linux gating. */
  lingerHint?: typeof lingerHint;
  /** Read-only probe for what a login start would still be missing. */
  preconditionNotes?: typeof startPreconditionNotes;
};

/**
 * Read-only checks for what autostart cannot arrange on its own.
 *
 * Registering only schedules `cpa start` at login, so whatever would make that
 * command fail today fails at every login too — and the login launcher discards
 * its output, so the user would never find out. Reported as notes rather than
 * refusals: `cpa auto on` before `cpa init` is a legitimate order for scripted
 * setups, and blocking it would be a behavior break.
 *
 * @internal exported for focused tests.
 */
export function startPreconditionNotes(): string[] {
  const notes: string[] = [];
  let ctx: ReturnType<typeof createContext>;
  try {
    ctx = createContext();
  } catch {
    // No resolvable instance home to check against; setAutostartEnabled still
    // reports the failures that actually block registration.
    return notes;
  }
  if (!fs.existsSync(ctx.layout.configFile)) {
    notes.push("no config.yaml yet, so a login start would fail — run: cpa init");
  }
  // The read-only probe: resolveRunnableExecutable would repair crash residue,
  // which a reporting-only command must not do.
  if (!inspectRunnableExecutable(ctx.home)) {
    notes.push("no CLIProxyAPI binary yet, so a login start would fail — run: cpa update");
  }
  return notes;
}

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
  const inspect = deps?.inspectState ?? inspectAutostartState;
  const set = deps?.setEnabled ?? setAutostartEnabled;
  const withLock = deps?.withLock ?? withMiniCpaLock;
  const detectGlobalInstall = deps?.detectGlobalInstall ?? detectNpmGlobalInstall;
  const hintLinger = deps?.lingerHint ?? lingerHint;
  const preconditionNotes = deps?.preconditionNotes ?? startPreconditionNotes;

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
  if (!enabled) return;
  // Preconditions first: they are the difference between a registration that
  // works at the next login and one that fails silently.
  for (const note of preconditionNotes()) console.error(`Note: ${note}`);
  const hint = await hintLinger();
  if (hint) console.error(`Note: ${hint}`);
}
