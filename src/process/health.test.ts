import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { httpFetch } from "../http.js";
import { withHttpFixture, withHttpsFixture } from "../test-fixtures/http-server.js";
import {
  apiBaseUrl,
  managementUrl,
  readinessUrls,
  waitForAnyHttpOk,
  waitForFirstHttpOk,
} from "./health.js";

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
    {
      env: { ...process.env, ...env },
    },
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
    if (code !== 0) throw new Error(`probe child exited with ${code}: ${stderr}`);
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
          res.end("up");
        },
      },
      async (base) => {
        assert.equal(await waitForAnyHttpOk([`${base}/ok`], 3000), true);
      },
    );
  });

  it("returns the endpoint that actually answered", async () => {
    await withHttpFixture(
      {
        "/ok": (_req, res) => {
          res.end("up");
        },
      },
      async (base) => {
        assert.equal(
          await waitForFirstHttpOk([`${base}/missing`, `${base}/ok`], 3000),
          `${base}/ok`,
        );
      },
    );
  });

  it("treats 401 as server-up", async () => {
    await withHttpFixture(
      {
        "/auth": (_req, res) => {
          res.statusCode = 401;
          res.end();
        },
      },
      async (base) => {
        assert.equal(await waitForAnyHttpOk([`${base}/auth`], 3000), true);
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
      async (base) => {
        assert.equal(await waitForAnyHttpOk([`${base}/broken`], 800), false);
      },
    );
  });

  it("returns false for an empty endpoint list", async () => {
    assert.equal(await waitForAnyHttpOk([], 500), false);
  });

  it("clamps the total timeout even when several endpoints hang", async () => {
    const started = Date.now();
    assert.equal(
      await waitForAnyHttpOk(["http://192.0.2.1:8081/", "http://192.0.2.2:8082/"], 1500),
      false,
    );
    assert.ok(Date.now() - started < 2500, "probe must not multiply the timeout by the URL count");
  });

  it("does not probe through global fetch", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("global fetch must not handle readiness");
    }) as typeof globalThis.fetch;
    try {
      await withHttpFixture(
        {
          "/ok": (_req, res) => {
            res.end("up");
          },
        },
        async (base) => {
          assert.equal(await waitForAnyHttpOk([`${base}/ok`], 3000), true);
        },
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("bypasses a dead proxy read at Node bootstrap", async () => {
    await withHttpFixture(
      {
        "/": (_req, res) => {
          res.end("up");
        },
      },
      async (base) => {
        assert.equal(
          await probeInChildProcess(`${base}/`, {
            NODE_USE_ENV_PROXY: "1",
            HTTP_PROXY: "http://127.0.0.1:9",
            http_proxy: "http://127.0.0.1:9",
            HTTPS_PROXY: "http://127.0.0.1:9",
            https_proxy: "http://127.0.0.1:9",
            NO_PROXY: "",
            no_proxy: "",
          }),
          "READY",
        );
      },
    );
  });

  it("accepts a self-signed CPA HTTPS certificate", async () => {
    await withHttpsFixture(
      {
        "/ok": (_req, res) => {
          res.end("up");
        },
      },
      async (base) => {
        assert.equal(await waitForAnyHttpOk([`${base}/ok`], 3000), true);
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
      async (base) => {
        assert.equal(await waitForAnyHttpOk([`${base}/auth`], 3000), true);
      },
    );
  });

  it("rejects 5xx-only HTTPS endpoints", async () => {
    await withHttpsFixture(
      {
        "/broken": (_req, res) => {
          res.statusCode = 500;
          res.end();
        },
      },
      async (base) => {
        assert.equal(await waitForAnyHttpOk([`${base}/broken`], 800), false);
      },
    );
  });

  it("does not disable certificate verification for download clients", async () => {
    await withHttpsFixture(
      {
        "/ok": (_req, res) => {
          res.end("up");
        },
      },
      async (base) => {
        assert.equal(await waitForAnyHttpOk([`${base}/ok`], 3000), true);
        await assert.rejects(() => httpFetch(`${base}/ok`, undefined, { retries: 0 }));
      },
    );
  });

  it("probes self-signed HTTPS in a child process", async () => {
    await withHttpsFixture(
      {
        "/": (_req, res) => {
          res.end("up");
        },
      },
      async (base) => {
        assert.equal(await probeInChildProcess(`${base}/`, {}), "READY");
      },
    );
  });
});

describe("readinessUrls", () => {
  const original = process.env.MINICPA_API_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.MINICPA_API_URL;
    else process.env.MINICPA_API_URL = original;
  });

  it("defaults to the loopback API root before the panel fallback", () => {
    delete process.env.MINICPA_API_URL;
    assert.equal(apiBaseUrl(), "http://127.0.0.1:8317");
    assert.equal(managementUrl(), "http://127.0.0.1:8317/management.html");
    assert.deepEqual(readinessUrls(), [
      "http://127.0.0.1:8317/",
      "http://127.0.0.1:8317/management.html",
    ]);
  });

  it("uses an explicit HTTPS IPv6 target without a configuration reader", () => {
    process.env.MINICPA_API_URL = "https://[::1]:9443/";
    assert.deepEqual(readinessUrls(), [
      "https://[::1]:9443/",
      "https://[::1]:9443/management.html",
    ]);
  });

  it("preserves reverse-proxy prefixes in both endpoints", () => {
    process.env.MINICPA_API_URL = "https://proxy.example/cpa/";
    assert.deepEqual(readinessUrls(), [
      "https://proxy.example/cpa/",
      "https://proxy.example/cpa/management.html",
    ]);
  });
});
