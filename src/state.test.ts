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
    writeInstallState(home, {
      runtimeVersion: "1.0.0",
      lastUpdateCheck: "2026-09-01T00:00:00.000Z",
    });
    patchInstallState(home, { runtimeVersion: "1.1.0" });
    const state = readInstallState(home);
    assert.equal(state.runtimeVersion, "1.1.0");
    assert.equal(state.lastUpdateCheck, "2026-09-01T00:00:00.000Z");
  });

  it("clears a field when the patch sets it to undefined", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-state-"));
    temps.push(home);
    writeInstallState(home, {
      runtimeVersion: "1.0.0",
      lastUpdateCheck: "2026-09-01T00:00:00.000Z",
    });
    patchInstallState(home, { runtimeVersion: undefined });
    const state = readInstallState(home);
    assert.equal(state.runtimeVersion, undefined);
    assert.equal(state.lastUpdateCheck, "2026-09-01T00:00:00.000Z");
  });

  it("drops legacy panel metadata on the next state write", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-state-"));
    temps.push(home);
    const stateDir = path.join(home, "state");
    fs.mkdirSync(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "install.json"),
      `${JSON.stringify({
        cpaHome: home,
        runtimeVersion: "1.0.0",
        panelVersion: "2.0.0",
        panelSha256: "a".repeat(64),
      })}\n`,
    );

    patchInstallState(home, { runtimeVersion: "1.1.0" });

    const raw = fs.readFileSync(path.join(stateDir, "install.json"), "utf8");
    assert.doesNotMatch(raw, /panelVersion|panelSha256/);
    assert.equal(readInstallState(home).runtimeVersion, "1.1.0");
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
