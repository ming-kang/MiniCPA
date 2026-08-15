import { createContext } from "../context.js";
import { readCurrentRuntimeVersion } from "../process/runtime.js";
import { readInstallState } from "../state.js";

export async function runVersion(cliVersion: string): Promise<void> {
  const ctx = createContext();
  const state = readInstallState(ctx.home);
  const runtime = await readCurrentRuntimeVersion(ctx.home);
  console.log(`minicpa   ${cliVersion}`);
  console.log(`CPA home  ${ctx.home}`);
  // Same missing-value wording as `cpa status` — it is one fact, so it reads one way.
  console.log(`cpa       ${runtime ?? "(not installed)"}`);
  console.log(`panel     ${state.panelVersion ?? "(not installed)"}`);
}
