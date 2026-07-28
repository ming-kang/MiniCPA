import { spawn } from "node:child_process";

export type OpenCommand = { command: string; args: string[] };

/**
 * Platform launcher for a URL.
 *
 * `platform` is overridable for tests only; the per-platform dispatch is exactly
 * what `openInBrowser` uses. A missing launcher (no `xdg-open` on a headless
 * box) surfaces as a `spawn <command> ENOENT` error, which callers report
 * without failing the command — the URL itself is already useful output.
 */
export function resolveOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): OpenCommand {
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

export async function openInBrowser(url: string): Promise<void> {
  const { command, args } = resolveOpenCommand(url);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    // Rejected as-is so the errno (`code === "ENOENT"`) survives for callers.
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
