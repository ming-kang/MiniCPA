import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  patchInstallState,
  readInstallState,
  readPidRecord,
  writeInstallState,
  writePidRecord,
} from "./state.js";

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
    assert.equal(state.cpaHome, home);
    assert.equal(fs.existsSync(home), false);
  });

  it("round-trips via writeInstallState", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-state-"));
    temps.push(home);
    writeInstallState(home, { runtimeVersion: "1.2.3" });
    assert.equal(readInstallState(home).runtimeVersion, "1.2.3");
  });
});

describe("patchInstallState", () => {
  it("merges without touching absent keys", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-state-"));
    temps.push(home);
    writeInstallState(home, { runtimeVersion: "1.0.0", panelVersion: "2.0.0" });
    patchInstallState(home, { runtimeVersion: "1.1.0" });
    const state = readInstallState(home);
    assert.equal(state.runtimeVersion, "1.1.0");
    assert.equal(state.panelVersion, "2.0.0");
  });

  it("clears a field when the patch sets it to undefined", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-state-"));
    temps.push(home);
    writeInstallState(home, { runtimeVersion: "1.0.0", panelVersion: "2.0.0" });
    patchInstallState(home, { runtimeVersion: undefined });
    const state = readInstallState(home);
    assert.equal(state.runtimeVersion, undefined);
    assert.equal(state.panelVersion, "2.0.0");
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
