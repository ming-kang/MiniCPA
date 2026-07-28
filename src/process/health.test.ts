import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { withHttpFixture } from "../test-fixtures/http-server.js";
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

  it("puts managementUrl first and the API root second", () => {
    const home = makeHome('host: "0.0.0.0"\nport: 9123\n');
    const urls = readinessUrls(home);
    assert.equal(urls.length, 2);
    assert.equal(urls[0], managementUrl(home));
    assert.equal(urls[0], "http://127.0.0.1:9123/management.html");
    assert.equal(urls[1], `${apiBaseUrl(home)}/`);
    assert.equal(urls[1], "http://127.0.0.1:9123/");
  });

  it("brackets IPv6 listen hosts consistently across both entries", () => {
    const home = makeHome('host: "::1"\nport: 9124\n');
    assert.equal(apiBaseUrl(home), "http://[::1]:9124");
    assert.deepEqual(readinessUrls(home), [
      "http://[::1]:9124/management.html",
      "http://[::1]:9124/",
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
