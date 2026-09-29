import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readLogChunk, tailFollowMany } from "./log-follow.js";

const tempDirs: string[] = [];
const originalExitCode = process.exitCode;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exitCode = originalExitCode;
});

function tempLog(name = "cpa.log"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-tail-follow-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

describe("readLogChunk", () => {
  it("returns only the bytes actually read and advances the cursor by that much", () => {
    const file = tempLog();
    fs.writeFileSync(file, "hello");

    const chunk = readLogChunk(file, 0, 4096);
    assert.equal(chunk.data.toString(), "hello");
    assert.equal(chunk.next, 5);
  });

  it("rewinds to the start when the file no longer has bytes at the cursor", () => {
    const file = tempLog();
    fs.writeFileSync(file, "hello");

    const chunk = readLogChunk(file, 5, 4096);
    assert.equal(chunk.data.length, 0);
    assert.equal(chunk.next, 0);
  });
});

describe("tailFollowMany", () => {
  it("waits for slow output before reading more data", async () => {
    const file = tempLog();
    fs.writeFileSync(file, "");
    let writes = 0;
    let release!: () => void;
    let firstWrite!: () => void;
    const ready = new Promise<void>((resolve) => {
      firstWrite = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const followed = tailFollowMany([file], {
      pollMs: 5,
      write: async () => {
        writes++;
        firstWrite();
        await blocked;
      },
    });
    fs.appendFileSync(file, Buffer.alloc(1024 * 1024, "x"));
    await ready;
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(writes, 1);
    } finally {
      process.emit("SIGINT", "SIGINT");
      release();
      await followed;
    }
  });

  it("streams an oversized unterminated line before its newline arrives", async () => {
    const file = tempLog();
    const err = path.join(path.dirname(file), "cpa.err.log");
    fs.writeFileSync(file, "");
    fs.writeFileSync(err, "");
    const chunks: string[] = [];
    let firstWrite!: () => void;
    const ready = new Promise<void>((resolve) => {
      firstWrite = resolve;
    });
    const followed = tailFollowMany([file, err], {
      pollMs: 5,
      write: (chunk) => {
        chunks.push(chunk.toString());
        firstWrite();
      },
    });
    fs.appendFileSync(file, "x".repeat(100000));
    await ready;
    process.emit("SIGINT", "SIGINT");
    await followed;
    assert.equal(chunks.join(""), `[out] ${"x".repeat(100000)}\n`);
  });
  it("rejects file access errors through its promise and cleans up listeners", async () => {
    const file = tempLog();
    fs.writeFileSync(file, "");
    const before = process.listenerCount("SIGINT");
    const originalOpen = fs.openSync;
    const followed = tailFollowMany([file], { pollMs: 5, write: () => {} });
    fs.openSync = (target, ...args) => {
      if (String(target) === file)
        throw Object.assign(new Error("access denied"), { code: "EACCES" });
      return originalOpen(target, ...args);
    };
    try {
      await assert.rejects(followed, /access denied/);
    } finally {
      fs.openSync = originalOpen;
    }
    assert.equal(process.listenerCount("SIGINT"), before);
  });

  it("follows a replacement larger than the previous file without skipping its beginning", async () => {
    const file = tempLog();
    fs.writeFileSync(file, "old\n");
    const writes: string[] = [];
    const followed = tailFollowMany([file], {
      pollMs: 5,
      write: (chunk) => {
        writes.push(chunk.toString());
      },
    });
    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, "replacement\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.emit("SIGINT", "SIGINT");
    await followed;
    assert.equal(writes.join(""), "replacement\n");
  });
  it("preserves partial lines and split UTF-8 characters across polling chunks", async () => {
    const outFile = tempLog();
    const errFile = path.join(path.dirname(outFile), "cpa.err.log");
    fs.writeFileSync(outFile, "");
    fs.writeFileSync(errFile, "");

    const originalLog = console.log;
    const writes: string[] = [];
    console.log = (): void => {};

    const encoded = Buffer.from("partial 世界");
    const splitAt = Buffer.byteLength("partial ") + 1;
    let followed: Promise<void>;
    let afterFirstPoll = "";
    let afterSecondPoll = "";
    try {
      followed = tailFollowMany([outFile, errFile], {
        pollMs: 20,
        write: (chunk) => {
          writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        },
      });
      fs.appendFileSync(outFile, encoded.subarray(0, splitAt));
      await new Promise((resolve) => setTimeout(resolve, 60));
      afterFirstPoll = writes.join("");

      fs.appendFileSync(outFile, Buffer.concat([encoded.subarray(splitAt), Buffer.from("\nnext")]));
      await new Promise((resolve) => setTimeout(resolve, 60));
      afterSecondPoll = writes.join("");

      process.emit("SIGINT", "SIGINT");
      await followed;
    } finally {
      console.log = originalLog;
    }

    assert.equal(afterFirstPoll, "", "an incomplete line must stay buffered");
    assert.equal(afterSecondPoll, "[out] partial 世界\n");
    assert.equal(writes.join(""), "[out] partial 世界\n[out] next\n");
  });

  it("returns on SIGINT with exit code 130 instead of killing the process", async () => {
    const file = tempLog();
    fs.writeFileSync(file, "line\n");
    const listenersBefore = process.listenerCount("SIGINT");

    const originalLog = console.log;
    const originalExit = process.exit;
    // process.exit() truncates queued stdout (a piped stdout is asynchronous on
    // Windows), so the follower must never call it.
    let exited = false;
    console.log = (): void => {};
    process.exit = ((code?: number): never => {
      exited = true;
      throw new Error(`process.exit(${code}) called`);
    }) as typeof process.exit;
    let followed: Promise<void>;
    try {
      followed = tailFollowMany([file]);
      try {
        process.emit("SIGINT", "SIGINT");
      } catch {
        /* recorded in `exited` and asserted below */
      }
      assert.equal(exited, false, "SIGINT must not terminate the process");
      await followed;
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }

    assert.equal(process.exitCode, 130);
    assert.equal(process.listenerCount("SIGINT"), listenersBefore);
  });
});
