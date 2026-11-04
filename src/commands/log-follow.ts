import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";

export function readLogChunk(
  file: string | number,
  pos: number,
  maxBytes: number,
): { data: Buffer; next: number } {
  const length = Math.max(0, maxBytes);
  if (length === 0) return { data: Buffer.alloc(0), next: pos };
  const buffer = Buffer.alloc(length);
  const fd = typeof file === "number" ? file : fs.openSync(file, "r");
  try {
    const count = fs.readSync(fd, buffer, 0, length, pos);
    return { data: buffer.subarray(0, count), next: count ? pos + count : 0 };
  } finally {
    if (typeof file !== "number") fs.closeSync(fd);
  }
}

type FollowFileState = {
  position: number;
  identity?: string;
  decoder: StringDecoder;
  pendingLine: string;
};

type FollowWriter = (chunk: string | Uint8Array) => void | Promise<void>;
export type TailFollowDeps = { pollMs?: number; write?: FollowWriter };
const READ_BYTES = 256 * 1024;
const MAX_PENDING_CHARACTERS = 64 * 1024;

function identity(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

function initialState(file: string, fromStart = false): FollowFileState {
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    position: fromStart ? 0 : (stat?.size ?? 0),
    identity: stat ? identity(stat) : undefined,
    decoder: new StringDecoder("utf8"),
    pendingLine: "",
  };
}

function prefixFor(file: string, count: number): string {
  return count <= 1 ? "" : `[${path.basename(file)}] `;
}

async function writeLines(
  state: FollowFileState,
  text: string,
  prefix: string,
  write: FollowWriter,
): Promise<void> {
  const lines = `${state.pendingLine}${text}`.split("\n");
  state.pendingLine = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    await write(`${prefix}${line}\n`);
  }
  if (state.pendingLine.length >= MAX_PENDING_CHARACTERS) {
    // Retain a possible CR until the next chunk determines whether it is CRLF.
    const end = state.pendingLine.endsWith("\r")
      ? state.pendingLine.length - 1
      : state.pendingLine.length;
    await write(`${prefix}${state.pendingLine.slice(0, end)}\n`);
    state.pendingLine = state.pendingLine.slice(end);
  }
}

async function flush(state: FollowFileState, prefix: string, write: FollowWriter): Promise<void> {
  const text = state.pendingLine + state.decoder.end();
  if (text) await write(`${prefix}${text.replace(/\r$/, "")}\n`);
  state.pendingLine = "";
}

export async function tailFollowMany(
  files: string[] | (() => string[]),
  deps?: TailFollowDeps,
): Promise<void> {
  const listFiles = typeof files === "function" ? files : () => files;
  const initialFiles = listFiles();
  const states = new Map(initialFiles.map((file) => [file, initialState(file)]));
  const filePrefix = (file: string): string =>
    prefixFor(file, typeof files === "function" ? 2 : states.size);
  const write: FollowWriter =
    deps?.write ??
    ((chunk) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()));
      }));
  const controller = new AbortController();
  const onSigint = (): void => {
    process.exitCode = 130;
    controller.abort();
  };
  process.once("SIGINT", onSigint);
  console.log(`Following ${initialFiles.join(" + ") || "new error log files"} (Ctrl+C to exit)`);
  try {
    let backlog = false;
    while (!controller.signal.aborted) {
      try {
        await delay(backlog ? 0 : (deps?.pollMs ?? 500), undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) break;
        throw error;
      }
      backlog = false;
      if (typeof files === "function") {
        const currentFiles = new Set(listFiles());
        for (const [file, state] of states) {
          if (!currentFiles.has(file)) {
            await flush(state, filePrefix(file), write);
            states.delete(file);
          }
        }
        for (const file of currentFiles) {
          if (!states.has(file)) states.set(file, initialState(file, true));
        }
      }
      for (const [file, state] of states) {
        if (controller.signal.aborted) break;
        const prefix = filePrefix(file);
        let fd: number;
        try {
          fd = fs.openSync(file, "r");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        let data: Buffer;
        try {
          const stat = fs.fstatSync(fd);
          if (identity(stat) !== state.identity || stat.size < state.position) {
            if (prefix) await flush(state, prefix, write);
            state.position = 0;
            state.decoder = new StringDecoder("utf8");
          }
          state.identity = identity(stat);
          if (stat.size <= state.position) continue;
          const chunk = readLogChunk(
            fd,
            state.position,
            Math.min(stat.size - state.position, READ_BYTES),
          );
          data = chunk.data;
          state.position = chunk.next;
          backlog ||= state.position < stat.size;
        } finally {
          fs.closeSync(fd);
        }
        if (prefix) await writeLines(state, state.decoder.write(data), prefix, write);
        else await write(data);
      }
    }
    for (const [file, state] of states) {
      const prefix = filePrefix(file);
      if (prefix) await flush(state, prefix, write);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
