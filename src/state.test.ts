import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readInstallState, readPidRecord, writeInstallState, writePidRecord } from "./state.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("readInstallState", () => {
  it("does not create directories on read", () => {
    const home = path.join(os.tmpdir(), `minicpa-state-missing-${Date.now()}`);
    temps.push(home);
    assert.equal(fs.existsSync(home), false);
    const state = readInstallState(home);
    assert.deepEqual(state, {});
    assert.equal(fs.existsSync(home), false);
  });

  it("round-trips via writeInstallState", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-state-"));
    temps.push(home);
    writeInstallState(home, { runtimeVersion: "1.2.3" });
    assert.equal(readInstallState(home).runtimeVersion, "1.2.3");
  });

  it("propagates malformed JSON instead of pretending the installation is unrecorded", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-state-"));
    temps.push(home);
    const file = path.join(home, "state", "install.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, "{not-json");
    assert.throws(() => readInstallState(home), SyntaxError);
    assert.equal(fs.readFileSync(file, "utf8"), "{not-json");
  });

  it("rejects invalid metadata shapes and non-string versions at the read boundary", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-state-"));
    temps.push(home);
    const file = path.join(home, "state", "install.json");
    fs.mkdirSync(path.dirname(file));
    for (const value of [
      null,
      [],
      true,
      42,
      "1.0.0",
      { runtimeVersion: 123 },
      { runtimeVersion: null },
    ]) {
      const raw = JSON.stringify(value);
      fs.writeFileSync(file, raw);
      assert.throws(() => readInstallState(home), /MiniCPA install metadata/);
      assert.equal(fs.readFileSync(file, "utf8"), raw);
    }
  });

  it("reads only the current field without rewriting legacy metadata", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-state-"));
    temps.push(home);
    const file = path.join(home, "state", "install.json");
    fs.mkdirSync(path.dirname(file));
    const raw = JSON.stringify({
      runtimeVersion: "1.0.0",
      lastUpdateCheck: "old",
      panelVersion: "2",
    });
    fs.writeFileSync(file, raw);
    assert.deepEqual(readInstallState(home), { runtimeVersion: "1.0.0" });
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  });

  it("propagates non-ENOENT filesystem failures", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-state-"));
    temps.push(home);
    fs.mkdirSync(path.join(home, "state", "install.json"), { recursive: true });
    assert.throws(
      () => readInstallState(home),
      (error: NodeJS.ErrnoException) => error.code === "EISDIR",
    );
  });
});

describe("writeInstallState", () => {
  it("writes a complete replacement rather than merging absent keys", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-state-"));
    temps.push(home);
    writeInstallState(home, { runtimeVersion: "1.0.0" });
    writeInstallState(home, { runtimeVersion: "1.1.0" });
    assert.deepEqual(readInstallState(home), { runtimeVersion: "1.1.0" });

    writeInstallState(home, {});
    assert.deepEqual(readInstallState(home), {});
  });

  it("writes only current metadata fields without retaining legacy home or panel data", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-state-"));
    temps.push(home);
    const stateDir = path.join(home, "state");
    fs.mkdirSync(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "install.json"),
      `${JSON.stringify({
        cpaHome: home,
        runtimeVersion: "1.0.0",
        lastUpdateCheck: "2026-09-01T00:00:00.000Z",
        panelVersion: "2.0.0",
        panelSha256: "a".repeat(64),
      })}\n`,
    );

    writeInstallState(home, { runtimeVersion: "1.1.0" });

    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "install.json"), "utf8")), {
      runtimeVersion: "1.1.0",
    });
  });
});

describe("readPidRecord", () => {
  it("rejects non-positive and non-integer PIDs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-pid-"));
    temps.push(home);
    writePidRecord(home, { pid: 42, exe: "x", startedAt: "" });
    assert.equal(readPidRecord(home)?.pid, 42);

    const layoutState = path.join(home, "state");
    fs.writeFileSync(path.join(layoutState, "cpa.pid"), "0\n");
    assert.equal(readPidRecord(home), undefined);

    fs.writeFileSync(path.join(layoutState, "cpa.pid"), "123abc\n");
    assert.equal(readPidRecord(home), undefined);

    fs.writeFileSync(path.join(layoutState, "cpa.pid"), "77\n");
    assert.equal(readPidRecord(home)?.pid, 77);
  });
});
