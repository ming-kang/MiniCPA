import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveOpenCommand } from "./browser.js";

describe("resolveOpenCommand", () => {
  it("uses the platform launcher without shell interpretation of the URL", () => {
    const url = "http://127.0.0.1:8317/management.html";

    assert.deepEqual(resolveOpenCommand(url, "win32"), {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
    assert.deepEqual(resolveOpenCommand(url, "darwin"), { command: "open", args: [url] });
    assert.deepEqual(resolveOpenCommand(url, "linux"), { command: "xdg-open", args: [url] });
  });

  it("defaults to the current platform", () => {
    const url = "http://127.0.0.1:8317/";
    assert.deepEqual(resolveOpenCommand(url), resolveOpenCommand(url, process.platform));
  });
});
