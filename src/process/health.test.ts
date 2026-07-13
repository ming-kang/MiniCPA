import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeListenHost } from "./health.js";

describe("normalizeListenHost", () => {
  it("maps IPv4 and IPv6 wildcards to loopback", () => {
    assert.equal(normalizeListenHost("0.0.0.0"), "127.0.0.1");
    assert.equal(normalizeListenHost("::"), "127.0.0.1");
    assert.equal(normalizeListenHost("[::]"), "127.0.0.1");
    assert.equal(normalizeListenHost("::0"), "127.0.0.1");
    assert.equal(normalizeListenHost("[::0]"), "127.0.0.1");
  });

  it("brackets concrete IPv6 addresses", () => {
    assert.equal(normalizeListenHost("::1"), "[::1]");
    assert.equal(normalizeListenHost("2001:db8::1"), "[2001:db8::1]");
  });

  it("leaves normal hostnames alone", () => {
    assert.equal(normalizeListenHost("127.0.0.1"), "127.0.0.1");
    assert.equal(normalizeListenHost("localhost"), "localhost");
  });
});
