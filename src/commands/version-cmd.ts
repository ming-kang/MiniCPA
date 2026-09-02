import { createContext } from "../context.js";
import { inspectRuntimeInstallation } from "../process/runtime.js";

export async function runVersion(cliVersion: string): Promise<void> {
  const ctx = createContext();
  const installed = inspectRuntimeInstallation(ctx.home);
  const runtime =
    installed.executable?.kind === "active" ? installed.state.runtimeVersion : undefined;
  const runtimeLabel = runtime ?? (installed.executable ? "(unknown)" : "(not installed)");
  console.log(`MiniCPA      ${cliVersion}`);
  console.log(`CLIProxyAPI  ${runtimeLabel}`);
  console.log(`Home         ${ctx.home}`);
}
