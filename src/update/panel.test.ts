import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { assertPanelContentSane, isInstalledPanelIntact } from "./panel.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("isInstalledPanelIntact", () => {
  it("accepts a panel with the recorded SHA-256", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-panel-"));
    temps.push(dir);
    const file = path.join(dir, "management.html");
    const content = "<html>panel</html>";
    fs.writeFileSync(file, content);
    const digest = crypto.createHash("sha256").update(content).digest("hex");

    assert.equal(
      isInstalledPanelIntact(file, { panelVersion: "1.2.3", panelSha256: digest }),
      true,
    );
  });

  it("rejects missing, altered, or untracked panel files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-panel-"));
    temps.push(dir);
    const file = path.join(dir, "management.html");
    fs.writeFileSync(file, "altered");

    assert.equal(
      isInstalledPanelIntact(file, { panelVersion: "1.2.3", panelSha256: "a".repeat(64) }),
      false,
    );
    assert.equal(
      isInstalledPanelIntact(path.join(dir, "missing.html"), {
        panelVersion: "1.2.3",
        panelSha256: "a".repeat(64),
      }),
      false,
    );
    assert.equal(isInstalledPanelIntact(file, { panelVersion: "1.2.3" }), false);
  });
});

describe("assertPanelContentSane", () => {
  it("accepts minimal HTML", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-panel-"));
    temps.push(dir);
    const file = path.join(dir, "management.html");
    fs.writeFileSync(file, "<!doctype html><html><body>panel</body></html>");
    assert.doesNotThrow(() => assertPanelContentSane(file));
  });

  it("rejects empty or non-html", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-panel-"));
    temps.push(dir);
    const empty = path.join(dir, "empty.html");
    fs.writeFileSync(empty, "x");
    assert.throws(() => assertPanelContentSane(empty), /too small/);
    const bad = path.join(dir, "bad.html");
    fs.writeFileSync(bad, "not html content at all here - plain text payload only!!!");
    assert.throws(() => assertPanelContentSane(bad), /does not look like HTML/);
  });
});
