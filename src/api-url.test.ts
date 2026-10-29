import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { apiBaseUrl, DEFAULT_API_URL } from "./api-url.js";

const original = process.env.MINICPA_API_URL;
afterEach(() => {
  if (original === undefined) delete process.env.MINICPA_API_URL;
  else process.env.MINICPA_API_URL = original;
});

describe("apiBaseUrl", () => {
  it("uses the bootstrap's loopback target without any config access", () => {
    delete process.env.MINICPA_API_URL;
    assert.equal(apiBaseUrl(), DEFAULT_API_URL);
    process.env.MINICPA_API_URL = "   ";
    assert.equal(apiBaseUrl(), DEFAULT_API_URL);
  });

  it("accepts an explicit HTTP or HTTPS target, including IPv6 and proxy prefixes", () => {
    for (const [input, expected] of [
      ["  http://localhost:9090///  ", "http://localhost:9090"],
      ["https://[::1]:9443/", "https://[::1]:9443"],
      ["https://proxy.example/cpa/", "https://proxy.example/cpa"],
    ]) {
      process.env.MINICPA_API_URL = input;
      assert.equal(apiBaseUrl(), expected);
    }
  });

  it("rejects invalid connection targets without exposing credentials or query tokens", () => {
    for (const input of [
      "not a URL",
      "file:///tmp/config.yaml",
      "javascript:alert(1)",
      "https://user:private-password@example.com",
      "https://example.com/?token=private-token",
      "https://example.com/#private-fragment",
    ]) {
      process.env.MINICPA_API_URL = input;
      assert.throws(
        () => apiBaseUrl(),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /absolute HTTP\(S\) base URL/);
          assert.doesNotMatch(error.message, /private-password|private-token|private-fragment/);
          return true;
        },
      );
    }
  });
});
