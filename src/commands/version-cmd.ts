import { createContext } from "../context.js";
import { readCurrentRuntimeVersion } from "../process/runtime.js";
import { readInstallState } from "../state.js";

export async function runVersion(cliVersion: string): Promise<void> {
  const ctx = createContext();
  const state = readInstallState(ctx.home);
  const runtime = await readCurrentRuntimeVersion(ctx.home);
  console.log(`MiniCPA      ${cliVersion}`);
  console.log(`CLIProxyAPI  ${runtime ?? "(not installed)"}`);
  console.log(`Web panel    ${state.panelVersion ?? "(not installed)"}`);
  console.log(`Home         ${ctx.home}`);
}
