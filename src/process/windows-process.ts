import { runCommand } from "./runtime.js";

export type WindowsProcessFacts = { startMarker?: string; executable?: string };
const PROBE_BUDGET_MS = 10_000;
let preferredShell = "pwsh.exe";

/** One process lookup provides both identity fields under one shared deadline. */
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
  const deadline = Date.now() + budgetMs;
  for (const shell of [
    preferredShell,
    preferredShell === "pwsh.exe" ? "powershell.exe" : "pwsh.exe",
  ]) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const result = await run(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        timeoutMs: remaining,
      });
      if (result.code !== 0) continue;
      const parsed: unknown = JSON.parse(result.stdout);
      if (!parsed || typeof parsed !== "object") continue;
      const facts = parsed as Record<string, unknown>;
      preferredShell = shell;
      return {
        startMarker:
          typeof facts.marker === "string" && /^\d+$/.test(facts.marker) ? facts.marker : undefined,
        executable:
          typeof facts.exe === "string" && facts.exe
            ? Buffer.from(facts.exe, "base64").toString("utf8")
            : undefined,
      };
    } catch {
      /* try the other available shell with only the remaining budget */
    }
  }
  return {};
}
