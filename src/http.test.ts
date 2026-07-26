import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeProxyEnv,
  formatNetworkError,
  hasProxyEnvConfigured,
  httpFetch,
  isRetryableHttpStatus,
  isRetryableNetworkError,
  NetworkError,
  redactProxyUrl,
  retryDelayMs,
} from "./http.js";
import { withHttpFixture } from "./test-fixtures/http-server.js";

// Loopback fixture requests must bypass any developer shell proxy. Set before
// the first httpFetch call so the lazily created proxy agent honors it.
process.env.NO_PROXY = "127.0.0.1";
process.env.no_proxy = "127.0.0.1";

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
  it("masks credentials and query secrets", () => {
    const redacted = redactProxyUrl(
      "http://user:secret@127.0.0.1:7890/?token=super-secret#credential",
    );
    assert.match(redacted, /\*\*\*/);
    assert.doesNotMatch(redacted, /user|secret|super-secret|credential/);
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
    const proxyKeys = [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
      "https_proxy",
      "http_proxy",
      "all_proxy",
    ] as const;
    const previous = new Map<string, string | undefined>(
      proxyKeys.map((key) => [key, process.env[key]]),
    );
    for (const key of proxyKeys) delete process.env[key];
    try {
      const message = formatNetworkError(err, "https://github.com/foo");
      assert.match(message, /github\.com/);
      assert.match(message, /UND_ERR_CONNECT_TIMEOUT|Connect Timeout/);
      assert.match(message, /HTTPS_PROXY/);
    } finally {
      for (const [key, value] of previous) {
        if (value !== undefined) process.env[key] = value;
        else delete process.env[key];
      }
    }
  });
});

describe("httpFetch", () => {
  it("retries a retryable status and returns the recovered response", async () => {
    let hits = 0;
    await withHttpFixture(
      {
        "/flaky": (_req, res) => {
          hits += 1;
          if (hits === 1) {
            res.statusCode = 503;
            res.end("try again with a body that should be cancelled, not drained");
            return;
          }
          res.statusCode = 200;
          res.end("recovered");
        },
      },
      async (baseUrl) => {
        const res = await httpFetch(`${baseUrl}/flaky`, undefined, {
          retries: 2,
          minDelayMs: 10,
          maxDelayMs: 20,
        });
        assert.equal(res.status, 200);
        assert.equal(await res.text(), "recovered");
        assert.equal(hits, 2);
      },
    );
  });

  it("returns non-retryable statuses as-is", async () => {
    await withHttpFixture(
      {
        "/gone": (_req, res) => {
          res.statusCode = 404;
          res.end("nope");
        },
      },
      async (baseUrl) => {
        const res = await httpFetch(`${baseUrl}/gone`, undefined, { retries: 2 });
        assert.equal(res.status, 404);
        await res.body?.cancel();
      },
    );
  });

  it("throws NetworkError for a refused connection", async () => {
    // Acquire a port that is guaranteed closed by opening and closing a fixture.
    let closedPort = 0;
    await withHttpFixture({}, async (baseUrl) => {
      closedPort = Number(new URL(baseUrl).port);
    });
    await assert.rejects(
      () =>
        httpFetch(`http://127.0.0.1:${closedPort}/`, undefined, {
          retries: 0,
        }),
      (err: unknown) => err instanceof NetworkError,
    );
  });
});

describe("retry helpers", () => {
  it("classifies retryable HTTP statuses", () => {
    assert.equal(isRetryableHttpStatus(200), false);
    assert.equal(isRetryableHttpStatus(404), false);
    assert.equal(isRetryableHttpStatus(408), true);
    assert.equal(isRetryableHttpStatus(429), true);
    assert.equal(isRetryableHttpStatus(500), true);
    assert.equal(isRetryableHttpStatus(503), true);
  });

  it("retries connect timeouts and refuses plain aborts", () => {
    const timeout = new TypeError("fetch failed", {
      cause: Object.assign(new Error("Connect Timeout Error"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    assert.equal(isRetryableNetworkError(timeout), true);

    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    assert.equal(isRetryableNetworkError(abort), false);
  });

  it("computes bounded backoff with deterministic random", () => {
    assert.equal(retryDelayMs(0, 400, 8_000, () => 0), 400);
    assert.equal(retryDelayMs(1, 400, 8_000, () => 0), 800);
    assert.equal(retryDelayMs(10, 400, 1_000, () => 0), 1_000);
  });
});
