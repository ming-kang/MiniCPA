import { lingerHint } from "../process/autostart-linux.js";
import fs from "node:fs";
import { createContext } from "../context.js";
import {
  inspectAutostartState,
  type AutostartState,
  setAutostartEnabled,
} from "../process/autostart.js";
import { withMiniCpaLock } from "../process/lock.js";
import { inspectRunnableExecutable } from "../process/runtime.js";
import { detectNpmGlobalInstall } from "../update/npm-global-detection.js";

export type AutoMode = "on" | "off";

export type AutoCommandDependencies = {
  inspectState?: typeof inspectAutostartState;
  setEnabled?: typeof setAutostartEnabled;
  withLock?: typeof withMiniCpaLock;
  detectGlobalInstall?: typeof detectNpmGlobalInstall;
  lingerHint?: typeof lingerHint;
  preconditionNotes?: typeof startPreconditionNotes;
};

export function startPreconditionNotes(): string[] {
  const notes: string[] = [];
  let ctx: ReturnType<typeof createContext>;
  try {
    ctx = createContext();
  } catch {
    return notes;
  }
  if (!fs.existsSync(ctx.layout.configFile)) {
    notes.push("no config.yaml yet, so a login start would fail — run: cpa init");
  }
  // Use read-only inspection: resolveRunnableExecutable performs crash recovery.
  if (!inspectRunnableExecutable(ctx.home)) {
    notes.push("no CLIProxyAPI binary yet, so a login start would fail — run: cpa update");
  }
  return notes;
}

function nextAutostartEnabled(current: AutostartState): boolean {
  // Stale and disabled registrations start nothing, so a toggle repairs and enables them.
  return current !== "on";
}

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
  for (const note of preconditionNotes()) console.error(`Note: ${note}`);
  const hint = await hintLinger();
  if (hint) console.error(`Note: ${hint}`);
}
