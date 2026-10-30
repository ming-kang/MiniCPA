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
});
