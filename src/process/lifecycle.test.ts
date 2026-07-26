import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { writePidRecord } from "../state.js";
import { isProcessAlive } from "./alive.js";
import { stopDaemon } from "./lifecycle.js";

const tempHomes: string[] = [];
const childPids: number[] = [];

afterEach(() => {
  for (const pid of childPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("process identity safety", () => {
  it("refuses to stop an alive PID when ownership cannot be verified", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-lifecycle-"));
    tempHomes.push(home);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!child.pid) throw new Error("failed to spawn test process");
    childPids.push(child.pid);
    writePidRecord(home, {
      pid: child.pid,
      exe: "",
      startedAt: new Date().toISOString(),
    });

    await assert.rejects(() => stopDaemon(home), /cannot verify process ownership/);
    assert.equal(isProcessAlive(child.pid), true);
  });
});
