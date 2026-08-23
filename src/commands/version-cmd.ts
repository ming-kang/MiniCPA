import { createContext } from "../context.js";
import { readCurrentRuntimeVersion } from "../process/runtime.js";
import { readInstallState } from "../state.js";

export type VersionDeps = {
  readCurrentRuntimeVersion?: (home: string) => Promise<string | undefined>;
};

export async function runVersion(cliVersion: string, deps?: VersionDeps): Promise<void> {
  const ctx = createContext();
  const state = readInstallState(ctx.home);
  const probeRuntime = deps?.readCurrentRuntimeVersion ?? readCurrentRuntimeVersion;
  const runtime = await probeRuntime(ctx.home);
  console.log(`MiniCPA      ${cliVersion}`);
  console.log(`CLIProxyAPI  ${runtime ?? "(not installed)"}`);
  console.log(`Web panel    ${state.panelVersion ?? "(not installed)"}`);
  console.log(`Home         ${ctx.home}`);
}
