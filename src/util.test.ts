import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBytes, parseCpaVersionFromHelp } from "./util.js";

describe("parseCpaVersionFromHelp", () => {
  it("extracts version line", () => {
    assert.equal(
      parseCpaVersionFromHelp("CLIProxyAPI Version: 7.2.66\nUsage:"),
      "7.2.66",
    );
  });

  it("returns undefined when missing", () => {
    assert.equal(parseCpaVersionFromHelp("no version here"), undefined);
  });
});

describe("formatBytes", () => {
  it("formats units", () => {
    assert.equal(formatBytes(500), "500 B");
    assert.equal(formatBytes(2048), "2.0 KB");
    assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  });
});
