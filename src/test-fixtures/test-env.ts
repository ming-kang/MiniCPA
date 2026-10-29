import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Capture console.log and console.error output during an async action. */
export async function captureConsole(fn: () => Promise<void> | void): Promise<{
  stdout: string[];
  stderr: string[];
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origErr = console.error;

  console.log = (...args: unknown[]) => {
    stdout.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };

  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }

  return { stdout, stderr };
}

/** Set up an isolated MiniCPA root in a temporary directory and return cleanup helper. */
export function createIsolatedTestEnv(prefix = "minicpa-test-"): {
  baseDir: string;
  cleanup: () => void;
} {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const origLocalAppData = process.env.LOCALAPPDATA;
  const origXdgDataHome = process.env.XDG_DATA_HOME;
  const origHome = process.env.HOME;
  const origCpaHome = process.env.CPA_HOME;
  const origExitCode = process.exitCode;
  const origWritable = process.env.WRITABLE_PATH;
  const origWritableLower = process.env.writable_path;

  process.env.LOCALAPPDATA = baseDir;
  process.env.XDG_DATA_HOME = baseDir;
  process.env.HOME = baseDir;
  delete process.env.CPA_HOME;
  delete process.env.WRITABLE_PATH;
  delete process.env.writable_path;

  const cleanup = (): void => {
    // Restore environment first so failures during file cleanup never contaminate subsequent tests.
    try {
      if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = origLocalAppData;
      if (origXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = origXdgDataHome;
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      if (origCpaHome === undefined) delete process.env.CPA_HOME;
      else process.env.CPA_HOME = origCpaHome;
      process.exitCode = origExitCode;
      delete process.env.WRITABLE_PATH;
      delete process.env.writable_path;
      if (origWritable !== undefined) process.env.WRITABLE_PATH = origWritable;
      if (origWritableLower !== undefined) process.env.writable_path = origWritableLower;
    } finally {
      try {
        fs.rmSync(baseDir, { recursive: true, force: true });
      } catch {
        /* best-effort directory cleanup on Windows file locking */
      }
    }
  };

  return { baseDir, cleanup };
}
