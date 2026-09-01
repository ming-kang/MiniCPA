import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * Read at most `maxBytes` from `pos`, reporting how far the cursor really moved.
 *
 * A log rotated between stat() and read() returns fewer bytes than requested, so
 * the cursor advances by bytes actually read. The zero-filled buffer is sliced
 * to ensure an unread tail never exposes uninitialized heap memory.
 *
 * @internal exported for tests only
 */
export function readLogChunk(
  file: string,
  pos: number,
  maxBytes: number,
): { data: Buffer; next: number } {
  const len = Math.max(0, maxBytes);
  if (len === 0) return { data: Buffer.alloc(0), next: pos };
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, "r");
  let read: number;
  try {
    read = fs.readSync(fd, buf, 0, len, pos);
  } finally {
    fs.closeSync(fd);
  }
  // Nothing there any more: the file was rotated/truncated under us, so restart
  // from the top instead of stranding the cursor past the new end.
  if (read === 0) return { data: Buffer.alloc(0), next: 0 };
  return { data: buf.subarray(0, read), next: pos + read };
}

type FollowFileState = {
  position: number;
  decoder: StringDecoder;
  pendingLine: string;
};

type FollowWriter = (chunk: string | Uint8Array) => void;

function followPrefix(file: string, fileCount: number): string {
  return fileCount > 1 ? `[${file.endsWith(".err.log") ? "err" : "out"}] ` : "";
}

function writePrefixedLogChunk(
  state: FollowFileState,
  data: Buffer,
  prefix: string,
  write: FollowWriter,
): void {
  const lines = `${state.pendingLine}${state.decoder.write(data)}`.split("\n");
  state.pendingLine = lines.pop() ?? "";
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    write(`${prefix}${line}\n`);
  }
}

function flushPrefixedLogState(state: FollowFileState, prefix: string, write: FollowWriter): void {
  const finalLine = `${state.pendingLine}${state.decoder.end()}`;
  state.pendingLine = "";
  if (!finalLine) return;
  const line = finalLine.endsWith("\r") ? finalLine.slice(0, -1) : finalLine;
  write(`${prefix}${line}\n`);
}

export type TailFollowDeps = {
  pollMs?: number;
  write?: FollowWriter;
};

/** Follow one or more log files until SIGINT, preserving line and UTF-8 boundaries. */
export async function tailFollowMany(files: string[], deps?: TailFollowDeps): Promise<void> {
  const state = new Map<string, FollowFileState>(
    files.map((file) => [
      file,
      {
        position: fs.existsSync(file) ? fs.statSync(file).size : 0,
        decoder: new StringDecoder("utf8"),
        pendingLine: "",
      },
    ]),
  );
  console.log(`Following ${files.join(" + ")} (Ctrl+C to exit)`);
  const write: FollowWriter = deps?.write ?? ((chunk) => void process.stdout.write(chunk));

  const interval = setInterval(() => {
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const fileState = state.get(file);
      if (!fileState) continue;
      const stat = fs.statSync(file);
      const prefix = followPrefix(file, files.length);
      if (stat.size < fileState.position) {
        if (prefix) flushPrefixedLogState(fileState, prefix, write);
        fileState.position = 0;
        fileState.decoder = new StringDecoder("utf8");
      }
      if (stat.size <= fileState.position) continue;

      const { data, next } = readLogChunk(
        file,
        fileState.position,
        Math.min(stat.size - fileState.position, 8 * 1024 * 1024),
      );
      fileState.position = next;
      if (data.length === 0) continue;
      if (prefix) writePrefixedLogChunk(fileState, data, prefix, write);
      else write(data);
    }
  }, deps?.pollMs ?? 500);

  let onSigint: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      // Resolving rather than process.exit() lets queued stdout drain on Windows.
      onSigint = (): void => {
        clearInterval(interval);
        for (const [file, fileState] of state) {
          const prefix = followPrefix(file, files.length);
          if (prefix) flushPrefixedLogState(fileState, prefix, write);
        }
        process.exitCode = 130;
        resolve();
      };
      process.once("SIGINT", onSigint);
    });
  } finally {
    clearInterval(interval);
    if (onSigint) process.removeListener("SIGINT", onSigint);
  }
}
