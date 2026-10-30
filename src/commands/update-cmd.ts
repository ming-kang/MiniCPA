import { apiBaseUrl } from "../api-url.js";
import { createContext } from "../context.js";
import { updateBinary, type BinaryUpdateResult } from "../update/binary.js";
import { consoleUpdateReporter } from "../update/reporter.js";

function updateResultLine(
  result: {
    version: string;
    previousVersion?: string;
    restarted?: boolean;
  },
  explicitVersion = false,
): string {
  const restartSuffix = result.restarted ? " (restarted)" : "";
  if (!result.previousVersion) {
    return `CLIProxyAPI installed: ${result.version}${restartSuffix}`;
  }
  if (result.previousVersion === result.version) {
    return `CLIProxyAPI reinstalled: ${result.version}${restartSuffix}`;
  }
  if (explicitVersion) {
    return `CLIProxyAPI version changed: ${result.previousVersion} → ${result.version}${restartSuffix}`;
  }
  return `CLIProxyAPI updated: ${result.previousVersion} → ${result.version}${restartSuffix}`;
}

export type UpdateDeps = {
  updateBinary: typeof updateBinary;
};

export type UpdateOptions = {
  version?: string;
  force?: boolean;
  insecure?: boolean;
};

const realUpdateDeps: UpdateDeps = { updateBinary };

export async function performUpdate(
  home: string,
  opts: UpdateOptions,
  deps: UpdateDeps = realUpdateDeps,
): Promise<BinaryUpdateResult> {
  const binary = await deps.updateBinary(home, {
    version: opts.version,
    force: opts.force,
    insecure: opts.insecure,
    reporter: consoleUpdateReporter(),
  });
  if (binary.skipped) {
    console.log(`CLIProxyAPI is already up to date (${binary.version})`);
  } else {
    console.log(updateResultLine(binary, opts.version !== undefined));
  }
  return binary;
}

export async function runUpdate(
  opts: UpdateOptions,
  deps: UpdateDeps = realUpdateDeps,
): Promise<void> {
  const ctx = createContext();
  apiBaseUrl();
  await performUpdate(ctx.home, opts, deps);
}
