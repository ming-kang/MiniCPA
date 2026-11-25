import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  condenseEventMessage,
  formatMiniCpaEvent,
  readLastMiniCpaEvent,
  recordMiniCpaEvent,
} from "./minicpa-log.js";
import { cpaLayout } from "./paths.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-log-"));
  temps.push(home);
  return home;
}

describe("condenseEventMessage", () => {
  it("flattens the multi-line errors startDaemon produces", () => {
    // A record spanning several lines would be read back as several records, and
    // a quoted CPA log tail could then pose as one of them.
    const condensed = condenseEventMessage(
      "CLIProxyAPI exited immediately.\n--- cpa.err.log (tail) ---\nbind: address in use\n",
    );
    assert.equal(
      condensed,
      "CLIProxyAPI exited immediately. --- cpa.err.log (tail) --- bind: address in use",
    );
    assert.ok(!condensed.includes("\n"));
  });

  it("caps a runaway message", () => {
    const condensed = condenseEventMessage("x".repeat(5000));
    assert.ok(condensed.length < 500, String(condensed.length));
    assert.ok(condensed.endsWith("..."));
  });
});

describe("recordMiniCpaEvent / readLastMiniCpaEvent", () => {
  it("round-trips a record through the log file", () => {
    const home = tempHome();
    const at = new Date("2026-08-26T03:04:05.000Z");
    assert.equal(recordMiniCpaEvent(home, "error", "start failed: Missing config", at), true);

    assert.deepEqual(readLastMiniCpaEvent(home), {
      at: "2026-08-26T03:04:05.000Z",
      level: "error",
      message: "start failed: Missing config",
    });
  });

  it("reports the newest record, so a later success clears an earlier failure", () => {
    const home = tempHome();
    recordMiniCpaEvent(home, "error", "start failed: Missing config", new Date(1000));
    recordMiniCpaEvent(home, "info", "start ok pid=42", new Date(2000));

    const last = readLastMiniCpaEvent(home);
    assert.equal(last?.level, "info");
    assert.equal(last?.message, "start ok pid=42");
  });

  it("returns undefined without a log, and skips back past unparseable lines", () => {
    const home = tempHome();
    assert.equal(readLastMiniCpaEvent(home), undefined);

    const file = cpaLayout(home).minicpaLogFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${formatMiniCpaEvent({ at: "2026-08-26T00:00:00.000Z", level: "error", message: "start failed: boom" })}\ntruncated residue\n`,
    );

    // The trailing line is not a record, so the real one behind it still counts.
    assert.equal(readLastMiniCpaEvent(home)?.message, "start failed: boom");
  });

  it("treats an unreadable log as no record rather than an error", () => {
    const home = tempHome();
    const file = cpaLayout(home).minicpaLogFile;
    fs.mkdirSync(file, { recursive: true });
    assert.equal(readLastMiniCpaEvent(home), undefined);
    assert.equal(recordMiniCpaEvent(home, "info", "start ok pid=1"), false);
  });

  it("keeps the log private on POSIX", { skip: process.platform === "win32" }, () => {
    const home = tempHome();
    const file = cpaLayout(home).minicpaLogFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "pre-existing\n", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    assert.equal(recordMiniCpaEvent(home, "info", "start ok pid=1"), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe("log rotation", () => {
  const OVERSIZED = 1024 * 1024;

  function seedOversizedLog(home: string): string {
    const file = cpaLayout(home).minicpaLogFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x".repeat(OVERSIZED));
    return file;
  }

  it("rotates an oversized log into a single retained generation", () => {
    const home = tempHome();
    const file = seedOversizedLog(home);
    const at = new Date("2026-08-26T03:04:05.000Z");

    assert.equal(recordMiniCpaEvent(home, "info", "start ok pid=7", at), true);

    assert.equal(fs.readFileSync(file, "utf8"), "2026-08-26T03:04:05.000Z info start ok pid=7\n");
    assert.equal(fs.statSync(`${file}.1`).size, OVERSIZED);
    assert.equal(fs.existsSync(`${file}.2`), false);
  });

  it("replaces the previous retained generation instead of accumulating rotations", () => {
    const home = tempHome();
    const file = seedOversizedLog(home);
    fs.writeFileSync(`${file}.1`, "old-1");

    assert.equal(recordMiniCpaEvent(home, "info", "start ok pid=7"), true);

    assert.equal(fs.statSync(`${file}.1`).size, OVERSIZED);
    assert.equal(fs.existsSync(`${file}.2`), false);
  });

  it("refuses to grow the log and preserves both generations when rotation is blocked", () => {
    const home = tempHome();
    const file = seedOversizedLog(home);
    fs.writeFileSync(`${file}.1`, "old-1");

    const originalRename = fs.renameSync;
    fs.renameSync = (): never => {
      throw new Error("EPERM: operation not permitted, rename");
    };
    try {
      assert.equal(recordMiniCpaEvent(home, "info", "start ok pid=7"), false);
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(fs.statSync(file).size, OVERSIZED);
    assert.equal(fs.readFileSync(`${file}.1`, "utf8"), "old-1");
  });

  it("keeps a small log unrotated", () => {
    const home = tempHome();
    assert.equal(recordMiniCpaEvent(home, "info", "start ok pid=7"), true);
    const file = cpaLayout(home).minicpaLogFile;
    assert.equal(fs.existsSync(`${file}.1`), false);
  });
});
