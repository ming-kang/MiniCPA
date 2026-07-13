import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeProxyEnv,
  formatNetworkError,
  hasProxyEnvConfigured,
  redactProxyUrl,
} from "./http.js";

describe("hasProxyEnvConfigured", () => {
  it("detects upper and lower case proxy vars", () => {
    assert.equal(hasProxyEnvConfigured({}), false);
    assert.equal(hasProxyEnvConfigured({ HTTPS_PROXY: "http://127.0.0.1:7890" }), true);
    assert.equal(hasProxyEnvConfigured({ http_proxy: "http://127.0.0.1:7890" }), true);
    assert.equal(hasProxyEnvConfigured({ ALL_PROXY: "socks5://127.0.0.1:1080" }), true);
    assert.equal(hasProxyEnvConfigured({ NO_PROXY: "localhost" }), false);
  });
});

describe("redactProxyUrl", () => {
  it("masks credentials", () => {
    assert.equal(
      redactProxyUrl("http://user:secret@127.0.0.1:7890"),
      "http://***:***@127.0.0.1:7890/",
    );
  });
});

describe("describeProxyEnv", () => {
  it("summarizes configured proxies", () => {
    const text = describeProxyEnv({
      HTTPS_PROXY: "http://user:pass@127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1",
    });
    assert.match(text, /HTTPS_PROXY=/);
    assert.match(text, /\*\*\*/);
    assert.match(text, /NO_PROXY=/);
    assert.equal(describeProxyEnv({}), "none");
  });
});

describe("formatNetworkError", () => {
  it("includes host and proxy hint when no proxy", () => {
    const err = new TypeError("fetch failed", {
      cause: Object.assign(new Error("Connect Timeout Error"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    const previous = process.env.HTTPS_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.https_proxy;
    delete process.env.http_proxy;
    delete process.env.all_proxy;
    try {
      const message = formatNetworkError(err, "https://github.com/foo");
      assert.match(message, /github\.com/);
      assert.match(message, /UND_ERR_CONNECT_TIMEOUT|Connect Timeout/);
      assert.match(message, /HTTPS_PROXY/);
    } finally {
      if (previous !== undefined) process.env.HTTPS_PROXY = previous;
    }
  });
});
