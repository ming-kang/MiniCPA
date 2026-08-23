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

  it("routes errors with a cause through the network formatter", () => {
    const err = new TypeError("fetch failed", { cause: new Error("ECONNREFUSED 127.0.0.1") });
    const message = formatCliError(err);
    assert.match(message, /fetch failed/);
    assert.match(message, /ECONNREFUSED/);
  });

  it("stringifies non-Error values", () => {
    assert.equal(formatCliError("boom"), "boom");
  });
});
