import fs from "node:fs";
import path from "node:path";
import { cpaLayout } from "./paths.js";
import { tailFile } from "./util.js";

export type MiniCpaEventLevel = "info" | "error";

export type MiniCpaEvent = {
  at: string;
  level: MiniCpaEventLevel;
  message: string;
};

const MAX_MESSAGE_LENGTH = 400;
const RECORD_PATTERN = /^(\S+) (info|error) ?(.*)$/;
const SCAN_LINES = 20;
const MINICPA_LOG_ROTATE_BYTES = 1024 * 1024;

function rotateFileIfLarge(file: string): boolean {
  try {
    if (fs.statSync(file).size < MINICPA_LOG_ROTATE_BYTES) return false;
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

function appendPrivateLogLine(file: string, line: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const rotated = rotateFileIfLarge(file);
    if (!rotated && fs.existsSync(file) && fs.statSync(file).size >= MINICPA_LOG_ROTATE_BYTES) {
      // Prevent unlimited log growth if rename/rotation is blocked.
      return false;
    }
    const fd = fs.openSync(file, "a", 0o600);
    try {
      fs.writeFileSync(fd, `${line}\n`);
    } finally {
      fs.closeSync(fd);
    }
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}

export function condenseEventMessage(message: string): string {
  const flattened = message.replace(/\s+/g, " ").trim();
  return flattened.length > MAX_MESSAGE_LENGTH
    ? `${flattened.slice(0, MAX_MESSAGE_LENGTH)}...`
    : flattened;
}

export function formatMiniCpaEvent(event: MiniCpaEvent): string {
  return `${event.at} ${event.level} ${event.message}`;
}

export function recordMiniCpaEvent(
  home: string,
  level: MiniCpaEventLevel,
  message: string,
  now: Date = new Date(),
): boolean {
  return appendPrivateLogLine(
    cpaLayout(home).minicpaLogFile,
    formatMiniCpaEvent({
      at: now.toISOString(),
      level,
      message: condenseEventMessage(message),
    }),
  );
}

export function readLastMiniCpaEvent(home: string): MiniCpaEvent | undefined {
  let tail: string;
  try {
    tail = tailFile(cpaLayout(home).minicpaLogFile, SCAN_LINES);
  } catch {
    return undefined;
  }
  if (!tail) return undefined;
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = RECORD_PATTERN.exec(lines[index] ?? "");
    if (!match) continue;
    return {
      at: match[1] ?? "",
      level: match[2] === "error" ? "error" : "info",
      message: match[3] ?? "",
    };
  }
  return undefined;
}
