import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withHttpFixture } from "../test-fixtures/http-server.js";
import { normalizeListenHost, waitForAnyHttpOk } from "./health.js";

describe("waitForAnyHttpOk", () => {
  it("accepts 200 responses", async () => {
    await withHttpFixture(
      {
        "/ok": (_req, res) => {
          res.statusCode = 200;
          res.end("up");
        },
      },
      async (baseUrl) => {
        assert.equal(await waitForAnyHttpOk([`${baseUrl}/ok`], 3_000), true);
      },
    );
  });

  it("treats 401 as server-up (auth-gated panel)", async () => {
    await withHttpFixture(
      {
        "/auth": (_req, res) => {
          res.statusCode = 401;
          res.end();
        },
      },
      async (baseUrl) => {
        assert.equal(await waitForAnyHttpOk([`${baseUrl}/auth`], 3_000), true);
      },
    );
  });

  it("rejects 5xx-only endpoints within the timeout", async () => {
    await withHttpFixture(
      {
        "/broken": (_req, res) => {
          res.statusCode = 500;
          res.end();
        },
      },
      async (baseUrl) => {
        assert.equal(await waitForAnyHttpOk([`${baseUrl}/broken`], 800), false);
      },
    );
  });

  it("returns false for an empty URL list", async () => {
    assert.equal(await waitForAnyHttpOk([], 500), false);
  });
});

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
