import type { CommandResult } from "./runtime.js";
import { runCommand } from "./runtime.js";
import { errnoCode } from "../util.js";

export type WindowsProcessFacts = { startMarker?: string; executable?: string };
const PROBE_BUDGET_MS = 10_000;

// PowerShell 7 starts much faster than Windows PowerShell 5.1, which can take seconds
// under load; the built-in shell is the fallback wherever pwsh is not installed.
const POWERSHELL_EXECUTABLES = ["pwsh.exe", "powershell.exe"] as const;
let preferredShell: (typeof POWERSHELL_EXECUTABLES)[number] = "pwsh.exe";

/**
 * Runs one `-Command` script with the first PowerShell that can be started. Only a
 * failure to start the shell moves on to the next one; a script that runs and fails
 * is reported as is. Every attempt shares one deadline.
 */
export async function runPowerShell(
  script: string,
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
  run: typeof runCommand = runCommand,
): Promise<CommandResult> {
  const deadline = Date.now() + options.timeoutMs;
  const order = [preferredShell, ...POWERSHELL_EXECUTABLES.filter((s) => s !== preferredShell)];
  let lastError: unknown = new Error("PowerShell is unavailable");
  for (const shell of order) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const result = await run(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        timeoutMs: remaining,
        env: options.env,
      });
      preferredShell = shell;
      return result;
    } catch (error) {
      lastError = error;
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  }
  throw lastError;
}

export async function readWindowsProcess(
  pid: number,
  run: typeof runCommand = runCommand,
  budgetMs = PROBE_BUDGET_MS,
): Promise<WindowsProcessFacts> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return {};
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-Process -Id ${pid}`,
    "$marker = $null; $exe = $null",
    "try { $marker = [string]$p.StartTime.ToUniversalTime().Ticks } catch {}",
    "try { if ($p.Path) { $exe = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p.Path)) } } catch {}",
    "[Console]::Out.Write((ConvertTo-Json @{ marker = $marker; exe = $exe } -Compress))",
  ].join("; ");
  try {
    const result = await runPowerShell(script, { timeoutMs: budgetMs }, run);
    if (result.code !== 0) return {};
    const parsed: unknown = JSON.parse(result.stdout);
    if (!parsed || typeof parsed !== "object") return {};
    const facts = parsed as Record<string, unknown>;
    return {
      startMarker:
        typeof facts.marker === "string" && /^\d+$/.test(facts.marker) ? facts.marker : undefined,
      executable:
        typeof facts.exe === "string" && facts.exe
          ? Buffer.from(facts.exe, "base64").toString("utf8")
          : undefined,
    };
  } catch {
    return {};
  }
}
