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
