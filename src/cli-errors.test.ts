import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCliError } from "./cli-errors.js";
import { NetworkError } from "./http.js";
import { BinaryUpdateError } from "./update/binary.js";

describe("formatCliError", () => {
  it("passes NetworkError messages through untouched", () => {
    const err = new NetworkError("Connect Timeout [UND_ERR_CONNECT_TIMEOUT] (github.com)", {
      cause: new Error("underlying"),
      url: "https://github.com/x",
    });
    assert.equal(formatCliError(err), err.message);
  });

  it("preserves the BinaryUpdateError restart suffix", () => {
    const restarted = new BinaryUpdateError("Checksum mismatch", true);
    assert.match(formatCliError(restarted), /existing CLIProxyAPI version was restarted/);
    const notRestarted = new BinaryUpdateError("Checksum mismatch", false);
    assert.match(formatCliError(notRestarted), /CLIProxyAPI version could not be restarted/);
  });

  it("returns plain error messages unchanged", () => {
    assert.equal(formatCliError(new Error("Missing config")), "Missing config");
  });

  it("routes unwrapped transport failures through the network formatter", () => {
    const err = new TypeError("fetch failed", { cause: new Error("connect refused 127.0.0.1") });
    const message = formatCliError(err);
    assert.match(message, /fetch failed ← connect refused/);

    const broken = new TypeError("terminated", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    assert.match(formatCliError(broken), /terminated ← other side closed \[UND_ERR_SOCKET\]/);
  });

  it("keeps the message of non-network errors that carry a cause", () => {
    const lock = new Error("Another cpa update is running (PID=42). Retry after it finishes.", {
      cause: Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }),
    });
    assert.equal(formatCliError(lock), lock.message);
    const npm = new Error("MiniCPA upgrade failed: npm exited with status 1.", {
      cause: new Error("network timeout while fetching"),
    });
    assert.equal(formatCliError(npm), npm.message);
  });

  it("stringifies non-Error values", () => {
    assert.equal(formatCliError("boom"), "boom");
  });
});
