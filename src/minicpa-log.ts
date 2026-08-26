import { cpaLayout } from "./paths.js";
import { appendPrivateLogLine, tailFile } from "./util.js";

/**
 * MiniCPA's own event log at `<home>/logs/minicpa.log`, kept separate from the
 * CPA child's stdout/stderr logs because it records what MiniCPA itself did.
 *
 * It exists for the autostart path. At login the Windows launcher runs
 * `wscript.exe` with the window hidden and discards this process's stdout and
 * stderr, and every failure that matters most there happens *before* the CPA
 * child exists — a missing `config.yaml`, a missing managed binary, or a held
 * global lock — so nothing reaches `cpa.err.log` either. Without this file those
 * logins fail in complete silence while `cpa status` still reports
 * `Autostart on`.
 *
 * This module owns the record format for both sides: `cpa start` writes and
 * `cpa doctor` reads. A format spelled out in two places would let a change to
 * the writer silently stop matching the reader.
 */

export type MiniCpaEventLevel = "info" | "error";

export type MiniCpaEvent = {
  /** ISO 8601 instant the record was written, kept verbatim for display. */
  at: string;
  level: MiniCpaEventLevel;
  message: string;
};

/** Cap a condensed message so a single error cannot dominate the whole log. */
const MAX_MESSAGE_LENGTH = 400;

/** `<ISO timestamp> <level> <message>` — the message may be empty. */
const RECORD_PATTERN = /^(\S+) (info|error) ?(.*)$/;

/** How far back to look for a parseable record before giving up. */
const SCAN_LINES = 20;

/**
 * Collapse a payload into exactly one loggable line.
 *
 * `startDaemon` builds errors that embed multi-line CPA log tails, and this file
 * is read back line by line, so an unflattened message would let a quoted log
 * tail masquerade as records of its own.
 *
 * @internal exported for focused format tests.
 */
export function condenseEventMessage(message: string): string {
  const flattened = message.replace(/\s+/g, " ").trim();
  return flattened.length > MAX_MESSAGE_LENGTH
    ? `${flattened.slice(0, MAX_MESSAGE_LENGTH)}...`
    : flattened;
}

/** @internal exported for focused format tests. */
export function formatMiniCpaEvent(event: MiniCpaEvent): string {
  return `${event.at} ${event.level} ${event.message}`;
}

/**
 * Record one MiniCPA event. Reports success, but never throws: callers write
 * here while already handling a failure, and a logging problem must not replace
 * the error the user needs to see.
 */
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

/**
 * The most recent parseable record, or undefined when there is none.
 *
 * Scans backwards rather than trusting the final line so that rotation residue
 * or a hand-edited file cannot hide a real record behind one unparseable one.
 * Reads only, and folds every failure into undefined: this is diagnostic
 * context, never a reason to fail the command asking for it.
 */
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
