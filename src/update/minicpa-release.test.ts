import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { withHttpFixture } from "../test-fixtures/http-server.js";
import {
  compareMinicpaVersions,
  fetchLatestMinicpaVersion,
  MINICPA_PACKAGE_NAME,
  minicpaLatestMetadataUrl,
  NPM_REGISTRY_BASE_URL,
} from "./minicpa-release.js";

process.env.NO_PROXY = "127.0.0.1";
process.env.no_proxy = "127.0.0.1";

const LATEST_PATH = "/@astralyn%2Fminicpa/latest";

function sendMetadata(res: ServerResponse, metadata: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(typeof metadata === "string" ? metadata : JSON.stringify(metadata));
}

async function withLatestResponse<T>(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  check: (baseUrl: string) => Promise<T>,
): Promise<T> {
  return withHttpFixture({ [LATEST_PATH]: handler }, check);
}

describe("MiniCPA npm registry metadata", () => {
  it("exports the fixed package/registry and constructs the scoped latest URL", () => {
    assert.equal(MINICPA_PACKAGE_NAME, "@astralyn/minicpa");
    assert.equal(NPM_REGISTRY_BASE_URL, "https://registry.npmjs.org");
    assert.equal(
      minicpaLatestMetadataUrl(),
      "https://registry.npmjs.org/@astralyn%2Fminicpa/latest",
    );
    assert.equal(
      minicpaLatestMetadataUrl("http://127.0.0.1:12345"),
      "http://127.0.0.1:12345/@astralyn%2Fminicpa/latest",
    );
    assert.throws(
      () => minicpaLatestMetadataUrl("https://registry.example.test"),
      /Refusing untrusted npm registry/,
    );
  });

  it("fetches a validated version with fixed public headers and no Authorization", async () => {
    const previousNpmToken = process.env.NPM_TOKEN;
    const previousNodeAuthToken = process.env.NODE_AUTH_TOKEN;
    process.env.NPM_TOKEN = "must-not-leak";
    process.env.NODE_AUTH_TOKEN = "must-not-leak-either";

    try {
      await withLatestResponse(
        (req, res) => {
          assert.equal(req.headers.accept, "application/json");
          assert.equal(req.headers["user-agent"], "MiniCPA");
          assert.equal(req.headers.authorization, undefined);
          sendMetadata(res, { name: MINICPA_PACKAGE_NAME, version: "0.1.10" });
        },
        async (baseUrl) => {
          assert.equal(await fetchLatestMinicpaVersion(baseUrl), "0.1.10");
        },
      );
    } finally {
      if (previousNpmToken === undefined) delete process.env.NPM_TOKEN;
      else process.env.NPM_TOKEN = previousNpmToken;
      if (previousNodeAuthToken === undefined) delete process.env.NODE_AUTH_TOKEN;
      else process.env.NODE_AUTH_TOKEN = previousNodeAuthToken;
    }
  });

  it("accepts canonical prerelease metadata", async () => {
    await withLatestResponse(
      (_req, res) => {
        sendMetadata(res, { name: MINICPA_PACKAGE_NAME, version: "1.0.0-rc.2" });
      },
      async (baseUrl) => {
        assert.equal(await fetchLatestMinicpaVersion(baseUrl), "1.0.0-rc.2");
      },
    );
  });

  it("rejects invalid JSON, non-object metadata, and a mismatched name", async () => {
    await withLatestResponse(
      (_req, res) => sendMetadata(res, "{not-json"),
      async (baseUrl) => {
        await assert.rejects(() => fetchLatestMinicpaVersion(baseUrl), /invalid JSON/);
      },
    );
    await withLatestResponse(
      (_req, res) => sendMetadata(res, []),
      async (baseUrl) => {
        await assert.rejects(() => fetchLatestMinicpaVersion(baseUrl), /expected a JSON object/);
      },
    );
    await withLatestResponse(
      (_req, res) => sendMetadata(res, { name: "@someone/else", version: "1.2.3" }),
      async (baseUrl) => {
        await assert.rejects(() => fetchLatestMinicpaVersion(baseUrl), /package name mismatch/);
      },
    );
  });

  it("rejects missing, invalid, and non-canonical exact versions", async () => {
    for (const metadata of [
      { name: MINICPA_PACKAGE_NAME },
      { name: MINICPA_PACKAGE_NAME, version: "not-semver" },
      { name: MINICPA_PACKAGE_NAME, version: "v1.2.3" },
      { name: MINICPA_PACKAGE_NAME, version: "1.2.3 || 2.0.0" },
      { name: MINICPA_PACKAGE_NAME, version: "01.2.3" },
    ]) {
      await withLatestResponse(
        (_req, res) => sendMetadata(res, metadata),
        async (baseUrl) => {
          await assert.rejects(
            () => fetchLatestMinicpaVersion(baseUrl),
            /exact semver|missing a string version/,
          );
        },
      );
    }
  });

  it("reports 404 and retry-exhausted 500 responses actionably", async () => {
    await withLatestResponse(
      (_req, res) => sendMetadata(res, { error: "not found" }, 404),
      async (baseUrl) => {
        await assert.rejects(
          () => fetchLatestMinicpaVersion(baseUrl),
          /not found in the npm registry \(HTTP 404\)/,
        );
      },
    );

    let attempts = 0;
    await withLatestResponse(
      (_req, res) => {
        attempts += 1;
        sendMetadata(res, { error: "temporary failure" }, 500);
      },
      async (baseUrl) => {
        await assert.rejects(
          () => fetchLatestMinicpaVersion(baseUrl),
          /failed with HTTP 500.*Retry later/,
        );
      },
    );
    assert.equal(attempts, 3);
  });

  it("aborts metadata that exceeds the bounded body limit", async () => {
    await withLatestResponse(
      (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.write("x".repeat(40 * 1024));
        res.end("x".repeat(25 * 1024));
      },
      async (baseUrl) => {
        await assert.rejects(
          () => fetchLatestMinicpaVersion(baseUrl),
          /exceeds the 65536-byte limit/,
        );
      },
    );
  });
});

describe("compareMinicpaVersions", () => {
  it("uses numeric semver ordering for 0.1.9 to 0.1.10", () => {
    assert.equal(compareMinicpaVersions("0.1.9", "0.1.10"), "outdated");
  });

  it("reports equal versions as current", () => {
    assert.equal(compareMinicpaVersions("0.1.10", "0.1.10"), "current");
  });

  it("reports a newer local version as ahead, never outdated", () => {
    assert.equal(compareMinicpaVersions("0.2.0", "0.1.10"), "ahead");
  });

  it("uses semver prerelease precedence", () => {
    assert.equal(compareMinicpaVersions("1.0.0-beta.1", "1.0.0-beta.2"), "outdated");
    assert.equal(compareMinicpaVersions("1.0.0", "1.0.1-rc.1"), "outdated");
    assert.equal(compareMinicpaVersions("1.0.0", "1.0.0-rc.1"), "ahead");
  });

  it("rejects invalid current and latest values", () => {
    assert.throws(() => compareMinicpaVersions("v1.0.0", "1.0.0"), /Invalid current/);
    assert.throws(() => compareMinicpaVersions("1.0.0", "latest"), /Invalid latest/);
  });
});
