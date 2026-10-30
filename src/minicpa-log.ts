import fs from "node:fs";
import path from "node:path";
import { cpaLayout } from "./paths.js";
import { appendPrivateLogLine, tailFile } from "./util.js";

export type MiniCpaEventLevel = "info" | "error";

export type MiniCpaEvent = {
  at: string;
  level: MiniCpaEventLevel;
  message: string;
};

const MAX_MESSAGE_LENGTH = 400;
const RECORD_PATTERN = /^(\S+) (info|error) ?(.*)$/;
const SCAN_LINES = 20;

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
    const current = cpaLayout(home).minicpaLogFile;
    const file = fs.existsSync(current) ? current : path.join(home, "logs", "minicpa.log");
    tail = tailFile(file, SCAN_LINES);
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
