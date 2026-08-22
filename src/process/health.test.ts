import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { httpFetch } from "../http.js";
import { withHttpFixture, withHttpsFixture } from "../test-fixtures/http-server.js";
import {
  apiBaseUrl,
  managementUrl,
  normalizeListenHost,
  readinessUrls,
  waitForAnyHttpOk,
} from "./health.js";

/**
 * Runs the readiness probe in a child process so proxy environment variables
 * are read at Node bootstrap (NODE_USE_ENV_PROXY only takes effect there).
 */
const PROBE_CHILD_SOURCE = [
  "const [, moduleUrl, targetUrl] = process.argv;",
  "const { waitForAnyHttpOk } = await import(moduleUrl);",
  "const ready = await waitForAnyHttpOk([targetUrl], 3000);",
  'process.stdout.write(ready ? "READY" : "UNREACHABLE");',
].join("\n");

async function probeInChildProcess(targetUrl: string, env: NodeJS.ProcessEnv): Promise<string> {
  const moduleUrl = new URL("./health.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", PROBE_CHILD_SOURCE, moduleUrl, targetUrl],
    { env: { ...process.env, ...env } },
  );
  const killTimer = setTimeout(() => child.kill(), 30_000);
  killTimer.unref();

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0) {
      throw new Error(`probe child exited with ${code}: ${stderr}`);
    }
  } finally {
    clearTimeout(killTimer);
  }
  return stdout.trim();
}

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

  it("honors timeoutMs even when several URLs hang", async () => {
    // TEST-NET-1 addresses black-hole the connection instead of refusing it, so
    // an unclamped probe would spend a full per-URL abort budget on each entry.
    const startedAt = Date.now();
    const ready = await waitForAnyHttpOk(
      ["http://192.0.2.1:8081/", "http://192.0.2.2:8082/"],
      1_500,
    );
    const elapsed = Date.now() - startedAt;
    assert.equal(ready, false);
    assert.ok(elapsed < 2_500, `probe overshot its 1500 ms budget: ${elapsed} ms`);
  });

  it("does not probe through global fetch", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("global fetch must not be used for loopback readiness probes");
    }) as typeof globalThis.fetch;
    try {
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
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("reaches a loopback server while NODE_USE_ENV_PROXY points at a dead proxy", async () => {
    await withHttpFixture(
      {
        "/": (_req, res) => {
          res.statusCode = 200;
          res.end("up");
        },
      },
      async (baseUrl) => {
        const result = await probeInChildProcess(`${baseUrl}/`, {
          NODE_USE_ENV_PROXY: "1",
          HTTP_PROXY: "http://127.0.0.1:9",
          http_proxy: "http://127.0.0.1:9",
          HTTPS_PROXY: "http://127.0.0.1:9",
          https_proxy: "http://127.0.0.1:9",
          NO_PROXY: "",
          no_proxy: "",
        });
        assert.equal(result, "READY");
      },
    );
  });

  it("probes an HTTPS server with self-signed certificate successfully", async () => {
    await withHttpsFixture(
      {
        "/ok": (_req, res) => {
          res.statusCode = 200;
          res.end("https up");
        },
      },
      async (baseUrl) => {
        assert.equal(await waitForAnyHttpOk([`${baseUrl}/ok`], 3_000), true);
      },
    );
  });

  it("treats 401 on HTTPS as server-up", async () => {
    await withHttpsFixture(
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

  it("rejects 5xx-only HTTPS endpoints within the timeout", async () => {
    await withHttpsFixture(
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

  it("strictly scopes self-signed bypass to readiness: httpFetch still rejects self-signed certs", async () => {
    await withHttpsFixture(
      {
        "/ok": (_req, res) => {
          res.statusCode = 200;
          res.end("ok");
        },
      },
      async (baseUrl) => {
        // waitForAnyHttpOk succeeds on loopback with self-signed cert
        assert.equal(await waitForAnyHttpOk([`${baseUrl}/ok`], 3_000), true);

        // General httpFetch (used by update/GitHub clients) must fail on self-signed cert
        await assert.rejects(() => httpFetch(`${baseUrl}/ok`, undefined, { retries: 0 }));
      },
    );
  });

  it("reaches an HTTPS server with self-signed certificate in a child process", async () => {
    await withHttpsFixture(
      {
        "/": (_req, res) => {
          res.statusCode = 200;
          res.end("https up");
        },
      },
      async (baseUrl) => {
        const result = await probeInChildProcess(`${baseUrl}/`, {});
        assert.equal(result, "READY");
      },
    );
  });
});

describe("readinessUrls", () => {
  const tempHomes: string[] = [];

  function makeHome(configYaml: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-health-"));
    tempHomes.push(home);
    fs.writeFileSync(path.join(home, "config.yaml"), configYaml, "utf8");
    return home;
  }

  afterEach(() => {
    while (tempHomes.length > 0) {
      const home = tempHomes.pop();
      if (home) fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("puts managementUrl first and the API root second, followed by IPv6 loopback for wildcards", () => {
    const home = makeHome('host: "0.0.0.0"\nport: 9123\n');
    const urls = readinessUrls(home);
    assert.equal(urls.length, 4);
    assert.equal(urls[0], managementUrl(home));
    assert.equal(urls[0], "http://127.0.0.1:9123/management.html");
    assert.equal(urls[1], `${apiBaseUrl(home)}/`);
    assert.equal(urls[1], "http://127.0.0.1:9123/");
    assert.equal(urls[2], "http://[::1]:9123/management.html");
    assert.equal(urls[3], "http://[::1]:9123/");
  });

  it("brackets IPv6 listen hosts consistently across both entries", () => {
    const home = makeHome('host: "::1"\nport: 9124\n');
    assert.equal(apiBaseUrl(home), "http://[::1]:9124");
    assert.deepEqual(readinessUrls(home), [
      "http://[::1]:9124/management.html",
      "http://[::1]:9124/",
    ]);
  });

  it("uses https:// when tls.enable is true with IPv4 wildcard", () => {
    const home = makeHome('host: "0.0.0.0"\nport: 9123\ntls:\n  enable: true\n');
    const urls = readinessUrls(home);
    assert.equal(urls.length, 4);
    assert.equal(managementUrl(home), "https://127.0.0.1:9123/management.html");
    assert.equal(apiBaseUrl(home), "https://127.0.0.1:9123");
    assert.equal(urls[0], "https://127.0.0.1:9123/management.html");
    assert.equal(urls[1], "https://127.0.0.1:9123/");
    assert.equal(urls[2], "https://[::1]:9123/management.html");
    assert.equal(urls[3], "https://[::1]:9123/");
  });

  it("uses https:// when tls.enable is true with IPv6 wildcard :: and [::]", () => {
    const homeColons = makeHome('host: "::"\nport: 9123\ntls:\n  enable: true\n');
    assert.deepEqual(readinessUrls(homeColons), [
      "https://127.0.0.1:9123/management.html",
      "https://127.0.0.1:9123/",
      "https://[::1]:9123/management.html",
      "https://[::1]:9123/",
    ]);

    const homeBracketed = makeHome('host: "[::]"\nport: 9123\ntls:\n  enable: true\n');
    assert.deepEqual(readinessUrls(homeBracketed), [
      "https://127.0.0.1:9123/management.html",
      "https://127.0.0.1:9123/",
      "https://[::1]:9123/management.html",
      "https://[::1]:9123/",
    ]);
  });

  it("uses https:// and brackets concrete IPv6 addresses when tls.enable is true", () => {
    const home = makeHome('host: "::1"\nport: 9124\ntls:\n  enable: true\n');
    assert.equal(apiBaseUrl(home), "https://[::1]:9124");
    assert.equal(managementUrl(home), "https://[::1]:9124/management.html");
    assert.deepEqual(readinessUrls(home), [
      "https://[::1]:9124/management.html",
      "https://[::1]:9124/",
    ]);
  });

  it("uses https:// with concrete IPv4 addresses when tls.enable is true", () => {
    const home = makeHome('host: "192.168.1.50"\nport: 9125\ntls:\n  enable: true\n');
    assert.equal(apiBaseUrl(home), "https://192.168.1.50:9125");
    assert.equal(managementUrl(home), "https://192.168.1.50:9125/management.html");
    assert.deepEqual(readinessUrls(home), [
      "https://192.168.1.50:9125/management.html",
      "https://192.168.1.50:9125/",
    ]);
  });

  it("uses http:// when tls.enable is explicitly false", () => {
    const home = makeHome('host: "127.0.0.1"\nport: 9123\ntls:\n  enable: false\n');
    assert.equal(apiBaseUrl(home), "http://127.0.0.1:9123");
    assert.equal(managementUrl(home), "http://127.0.0.1:9123/management.html");
    assert.deepEqual(readinessUrls(home), [
      "http://127.0.0.1:9123/management.html",
      "http://127.0.0.1:9123/",
    ]);
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
