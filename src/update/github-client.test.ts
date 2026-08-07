import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { withHttpFixture } from "../test-fixtures/http-server.js";

// Loopback fixture requests must bypass any developer shell proxy. Set before
// the first httpFetch call so the lazily created proxy agent honors it.
process.env.NO_PROXY = "127.0.0.1";
process.env.no_proxy = "127.0.0.1";
import { NetworkError } from "../http.js";
import {
  browserReleaseAssetUrl,
  checkGithubReachability,
  downloadToFile,
  ensureReleaseTag,
  fetchChecksums,
  fetchLatestReleaseViaApi,
  githubAuthToken,
  githubHeaders,
  isAllowedGithubDownloadUrl,
  isSafeReleaseTag,
  normalizeTagVersion,
  parseChecksumsText,
  parseGithubDigest,
  parseReleaseTagFromLocation,
  releaseAssetDownloadUrl,
  repoFromPanelUrl,
  resolveLatestReleaseTag,
  type GhRelease,
} from "./github-client.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("normalizeTagVersion", () => {
  it("strips leading v", () => {
    assert.equal(normalizeTagVersion("v7.2.66"), "7.2.66");
    assert.equal(normalizeTagVersion("7.2.66"), "7.2.66");
    assert.equal(normalizeTagVersion("V1.0.0"), "1.0.0");
  });
});

describe("ensureReleaseTag / isSafeReleaseTag", () => {
  it("adds leading v", () => {
    assert.equal(ensureReleaseTag("7.2.66"), "v7.2.66");
    assert.equal(ensureReleaseTag("v7.2.66"), "v7.2.66");
  });

  it("rejects path-like tags", () => {
    assert.equal(isSafeReleaseTag("../evil"), false);
    assert.throws(() => ensureReleaseTag("../evil"), /Invalid release tag/);
  });
});

describe("githubAuthToken", () => {
  it("prefers GITHUB_TOKEN over GH_TOKEN", () => {
    assert.equal(githubAuthToken({ GITHUB_TOKEN: "ghp_a", GH_TOKEN: "ghp_b" }), "ghp_a");
  });

  it("falls back to GH_TOKEN", () => {
    assert.equal(githubAuthToken({ GH_TOKEN: "ghp_b" }), "ghp_b");
  });

  it("returns undefined when unset or blank", () => {
    assert.equal(githubAuthToken({}), undefined);
    assert.equal(githubAuthToken({ GITHUB_TOKEN: "  " }), undefined);
  });
});

describe("repoFromPanelUrl", () => {
  it("parses github URLs", () => {
    assert.equal(
      repoFromPanelUrl("https://github.com/router-for-me/Cli-Proxy-API-Management-Center"),
      "router-for-me/Cli-Proxy-API-Management-Center",
    );
    assert.equal(repoFromPanelUrl("https://github.com/foo/bar.git"), "foo/bar");
    assert.equal(repoFromPanelUrl("https://github.com/foo/bar/releases/latest"), "foo/bar");
  });

  it("rejects non-github and spoofed URLs", () => {
    assert.throws(() => repoFromPanelUrl("https://gitlab.com/a/b"), /Unsupported/);
    assert.throws(() => repoFromPanelUrl("https://evil.example/github.com/a/b"), /Unsupported/);
    assert.throws(() => repoFromPanelUrl("http://github.com/a/b"), /Unsupported/);
    assert.throws(() => repoFromPanelUrl("https://github.com/a"), /Unsupported/);
  });
});

describe("parseReleaseTagFromLocation", () => {
  it("parses absolute releases/tag Location", () => {
    assert.equal(
      parseReleaseTagFromLocation(
        "https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.92",
      ),
      "v7.2.92",
    );
  });

  it("parses relative Location", () => {
    assert.equal(
      parseReleaseTagFromLocation("/router-for-me/CLIProxyAPI/releases/tag/v1.0.0"),
      "v1.0.0",
    );
  });

  it("returns undefined for unrelated URLs", () => {
    assert.equal(parseReleaseTagFromLocation("https://github.com/o/r"), undefined);
  });
});

describe("browserReleaseAssetUrl", () => {
  it("builds public download URLs", () => {
    assert.equal(
      browserReleaseAssetUrl("owner/repo", "7.0.0", "CLIProxyAPI_7.0.0_windows_amd64.zip"),
      "https://github.com/owner/repo/releases/download/v7.0.0/CLIProxyAPI_7.0.0_windows_amd64.zip",
    );
  });
});

describe("parseChecksumsText / parseGithubDigest", () => {
  it("parses sha256 lines", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const map = parseChecksumsText(`${a}  foo/bar\n${b}\tcli-proxy-api\n`);
    assert.equal(map.get("foo/bar"), a);
    assert.equal(map.get("cli-proxy-api"), b);
  });

  it("strips the sha256sum binary-mode marker from the file name", () => {
    const a = "a".repeat(64);
    const map = parseChecksumsText(`${a} *CLIProxyAPI_7.2.66_linux_amd64.tar.gz\n`);
    assert.equal(map.get("CLIProxyAPI_7.2.66_linux_amd64.tar.gz"), a);
    assert.equal(map.has("*CLIProxyAPI_7.2.66_linux_amd64.tar.gz"), false);
  });

  it("parses asset digest", () => {
    assert.equal(parseGithubDigest(`sha256:${"c".repeat(64)}`), "c".repeat(64));
    assert.equal(parseGithubDigest("md5:abc"), undefined);
  });

  it("returns undefined for a non-string digest", () => {
    assert.equal(parseGithubDigest(12_345 as unknown as string), undefined);
    assert.equal(parseGithubDigest({} as unknown as string), undefined);
  });
});

describe("githubHeaders", () => {
  const tokenKeys = ["GITHUB_TOKEN", "GH_TOKEN"] as const;
  const savedTokens = new Map<string, string | undefined>();

  function setTokens(values: Partial<Record<(typeof tokenKeys)[number], string>>): void {
    for (const key of tokenKeys) {
      if (!savedTokens.has(key)) savedTokens.set(key, process.env[key]);
      delete process.env[key];
    }
    for (const key of tokenKeys) {
      const value = values[key];
      if (value !== undefined) process.env[key] = value;
    }
  }

  afterEach(() => {
    for (const key of tokenKeys) delete process.env[key];
    for (const [key, value] of savedTokens) {
      if (value !== undefined) process.env[key] = value;
    }
    savedTokens.clear();
  });

  it("attaches Authorization on API paths when a token is set", () => {
    setTokens({ GITHUB_TOKEN: "ghp_test" });
    assert.equal(githubHeaders("json").Authorization, "Bearer ghp_test");
    assert.equal(githubHeaders("download").Authorization, "Bearer ghp_test");
  });

  it("never attaches Authorization to browser downloads", () => {
    setTokens({ GITHUB_TOKEN: "ghp_test" });
    assert.equal(githubHeaders("browser").Authorization, undefined);
  });

  it("omits Authorization when no token is set", () => {
    setTokens({});
    assert.equal(githubHeaders("json").Authorization, undefined);
    assert.equal(githubHeaders("json").Accept, "application/vnd.github+json");
  });
});

describe("fetchLatestReleaseViaApi", () => {
  it("rejects non-release JSON bodies with an actionable message", async () => {
    for (const body of ["{}", "[]", "null"]) {
      await withHttpFixture(
        {
          "/repos/owner/repo/releases/latest": (_req, res) => {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(body);
          },
        },
        async (baseUrl) => {
          await assert.rejects(
            () => fetchLatestReleaseViaApi("owner/repo", baseUrl),
            (err: unknown) => {
              assert.ok(err instanceof Error);
              assert.ok(!(err instanceof TypeError), `TypeError leaked for body ${body}`);
              assert.match(err.message, /invalid release metadata/);
              return true;
            },
          );
        },
      );
    }
  });

  it("accepts a well-formed release", async () => {
    await withHttpFixture(
      {
        "/repos/owner/repo/releases/latest": (_req, res) => {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              tag_name: "v7.2.92",
              name: "v7.2.92",
              published_at: "",
              assets: [
                {
                  name: "a.zip",
                  browser_download_url:
                    "https://github.com/owner/repo/releases/download/v7.2.92/a.zip",
                },
              ],
            }),
          );
        },
      },
      async (baseUrl) => {
        const release = await fetchLatestReleaseViaApi("owner/repo", baseUrl);
        assert.equal(release.tag_name, "v7.2.92");
        assert.equal(release.assets[0]?.name, "a.zip");
      },
    );
  });

  it("rejects assets whose download URL is off GitHub", async () => {
    await withHttpFixture(
      {
        "/repos/owner/repo/releases/latest": (_req, res) => {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              tag_name: "v7.2.92",
              name: "v7.2.92",
              published_at: "",
              assets: [{ name: "a.zip", browser_download_url: "https://evil.example/a.zip" }],
            }),
          );
        },
      },
      async (baseUrl) => {
        await assert.rejects(
          () => fetchLatestReleaseViaApi("owner/repo", baseUrl),
          /untrusted download URL/,
        );
      },
    );
  });
});

describe("checkGithubReachability", () => {
  const tokenKeys = ["GITHUB_TOKEN", "GH_TOKEN"] as const;
  const savedTokens = new Map<string, string | undefined>();

  afterEach(() => {
    for (const key of tokenKeys) delete process.env[key];
    for (const [key, value] of savedTokens) {
      if (value !== undefined) process.env[key] = value;
    }
    savedTokens.clear();
  });

  function clearTokens(): void {
    for (const key of tokenKeys) {
      if (!savedTokens.has(key)) savedTokens.set(key, process.env[key]);
      delete process.env[key];
    }
  }

  it("reports core rate limit and sends the API token", async () => {
    clearTokens();
    process.env.GITHUB_TOKEN = "ghp_probe";
    let seenAuth: string | undefined;
    await withHttpFixture(
      {
        "/rate_limit": (req, res) => {
          seenAuth = req.headers.authorization;
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ resources: { core: { remaining: 4_999 } } }));
        },
      },
      async (baseUrl) => {
        const result = await checkGithubReachability(baseUrl);
        assert.deepEqual(result, {
          ok: true,
          status: 200,
          remaining: 4_999,
          authenticated: true,
        });
        assert.equal(seenAuth, "Bearer ghp_probe");
      },
    );
  });

  it("reports an unreachable API without a rate limit", async () => {
    clearTokens();
    await withHttpFixture(
      {
        "/rate_limit": (req, res) => {
          assert.equal(req.headers.authorization, undefined);
          res.statusCode = 403;
          res.end("forbidden");
        },
      },
      async (baseUrl) => {
        const result = await checkGithubReachability(baseUrl);
        assert.equal(result.ok, false);
        assert.equal(result.status, 403);
        assert.equal(result.remaining, undefined);
        assert.equal(result.authenticated, false);
      },
    );
  });
});

describe("downloadToFile", () => {
  it("enforces a streamed maximum and removes partial output", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-download-"));
    tempDirs.push(dir);
    const dest = path.join(dir, "payload.bin");
    await assert.rejects(
      () => downloadToFile("data:application/octet-stream,hello", dest, { maxBytes: 4 }),
      /exceeds 4 B limit/,
    );
    assert.equal(fs.existsSync(dest), false);
  });

  it("reports a mid-stream connection failure as an enriched NetworkError", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-download-"));
    tempDirs.push(dir);
    const dest = path.join(dir, "payload.bin");
    await withHttpFixture(
      {
        "/truncated.bin": (_req, res) => {
          res.statusCode = 200;
          // Promise far more than we send, then drop the socket mid-body.
          res.setHeader("content-length", "1048576");
          res.write("partial payload", () => {
            res.socket?.destroy();
          });
        },
      },
      async (baseUrl) => {
        const url = `${baseUrl}/truncated.bin`;
        const host = new URL(baseUrl).host;
        await assert.rejects(
          () => downloadToFile(url, dest, { label: "truncated.bin" }),
          (err: unknown) => {
            assert.ok(err instanceof NetworkError, `expected NetworkError, got ${String(err)}`);
            assert.equal(err.url, url);
            assert.ok(err.message.includes(host), `message should name the host: ${err.message}`);
            return true;
          },
        );
        assert.equal(fs.existsSync(dest), false);
      },
    );
  });

  it("aborts a connection that opens and then sends nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-download-"));
    tempDirs.push(dir);
    const dest = path.join(dir, "payload.bin");
    await withHttpFixture(
      {
        "/stalled.bin": (_req, res) => {
          res.statusCode = 200;
          res.setHeader("content-length", "1048576");
          res.flushHeaders();
          // Never write a body: the total timeout would take 5 minutes to notice.
        },
      },
      async (baseUrl) => {
        await assert.rejects(
          () =>
            downloadToFile(`${baseUrl}/stalled.bin`, dest, {
              label: "stalled.bin",
              stallTimeoutMs: 200,
            }),
          (err: unknown) => {
            assert.ok(err instanceof NetworkError, `expected NetworkError, got ${String(err)}`);
            assert.match(err.message, /Download stalled \(no data for 1s\): stalled\.bin/);
            return true;
          },
        );
        assert.equal(fs.existsSync(dest), false);
      },
    );
  });
});

describe("resolveLatestReleaseTag", () => {
  it("reads the tag from a 302 Location header", async () => {
    await withHttpFixture(
      {
        "/owner/repo/releases/latest": (_req, res) => {
          res.statusCode = 302;
          res.setHeader("location", "https://github.com/owner/repo/releases/tag/v7.2.92");
          res.end();
        },
      },
      async (baseUrl) => {
        assert.equal(await resolveLatestReleaseTag("owner/repo", baseUrl), "v7.2.92");
      },
    );
  });

  it("fails clearly when no usable Location is present", async () => {
    await withHttpFixture(
      {
        "/owner/repo/releases/latest": (_req, res) => {
          res.statusCode = 200;
          res.end("<html>releases page</html>");
        },
      },
      async (baseUrl) => {
        await assert.rejects(
          () => resolveLatestReleaseTag("owner/repo", baseUrl),
          /Could not resolve latest release tag/,
        );
      },
    );
  });

  it("rejects unsafe tags from the Location header", async () => {
    await withHttpFixture(
      {
        "/owner/repo/releases/latest": (_req, res) => {
          res.statusCode = 302;
          res.setHeader("location", "https://github.com/owner/repo/releases/tag/..%2Fevil");
          res.end();
        },
      },
      async (baseUrl) => {
        await assert.rejects(
          () => resolveLatestReleaseTag("owner/repo", baseUrl),
          /not a safe version string/,
        );
      },
    );
  });
});

describe("fetchChecksums", () => {
  function releaseWithChecksums(url: string): GhRelease {
    return {
      tag_name: "v7.0.0",
      name: "v7.0.0",
      published_at: "",
      assets: [{ name: "checksums.txt", browser_download_url: url }],
    };
  }

  it("downloads and parses checksums end-to-end", async () => {
    const sum = "a".repeat(64);
    await withHttpFixture(
      {
        "/checksums.txt": (_req, res) => {
          res.statusCode = 200;
          res.end(`${sum}  CLIProxyAPI_7.0.0_windows_amd64.zip\n`);
        },
      },
      async (baseUrl) => {
        const map = await fetchChecksums(
          releaseWithChecksums(`${baseUrl}/checksums.txt`),
          "owner/repo",
        );
        assert.equal(map.get("CLIProxyAPI_7.0.0_windows_amd64.zip"), sum);
      },
    );
  });

  it("gives an actionable error on HTTP failure", async () => {
    await withHttpFixture(
      {
        "/checksums.txt": (_req, res) => {
          res.statusCode = 404;
          res.end();
        },
      },
      async (baseUrl) => {
        await assert.rejects(
          () => fetchChecksums(releaseWithChecksums(`${baseUrl}/checksums.txt`), "owner/repo"),
          /Failed to download checksums\.txt \(HTTP 404\)/,
        );
      },
    );
  });

  it("rejects an empty or unparseable checksums file", async () => {
    await withHttpFixture(
      {
        "/checksums.txt": (_req, res) => {
          res.statusCode = 200;
          res.end("this is not a checksums file\n");
        },
      },
      async (baseUrl) => {
        await assert.rejects(
          () => fetchChecksums(releaseWithChecksums(`${baseUrl}/checksums.txt`), "owner/repo"),
          /empty or unparseable/,
        );
      },
    );
  });
});

describe("isAllowedGithubDownloadUrl", () => {
  it("accepts GitHub release, API, and CDN hosts over HTTPS", () => {
    assert.equal(
      isAllowedGithubDownloadUrl("https://github.com/o/r/releases/download/v1/a.zip"),
      true,
    );
    assert.equal(
      isAllowedGithubDownloadUrl("https://api.github.com/repos/o/r/releases/assets/1"),
      true,
    );
    assert.equal(
      isAllowedGithubDownloadUrl(
        "https://objects.githubusercontent.com/github-production-release-asset/1",
      ),
      true,
    );
    assert.equal(
      isAllowedGithubDownloadUrl("https://release-assets.githubusercontent.com/a.zip"),
      true,
    );
  });

  it("rejects HTTP and non-GitHub hosts", () => {
    assert.equal(
      isAllowedGithubDownloadUrl("http://github.com/o/r/releases/download/v1/a.zip"),
      false,
    );
    assert.equal(isAllowedGithubDownloadUrl("https://evil.example/a.zip"), false);
    assert.equal(isAllowedGithubDownloadUrl("not-a-url"), false);
  });
});

describe("releaseAssetDownloadUrl", () => {
  it("prefers browser URL over API asset id", () => {
    assert.equal(
      releaseAssetDownloadUrl("owner/repo", {
        id: 42,
        name: "a.zip",
        browser_download_url: "https://github.com/owner/repo/releases/download/v1/a.zip",
      }),
      "https://github.com/owner/repo/releases/download/v1/a.zip",
    );
  });

  it("falls back to API asset id without browser URL", () => {
    assert.equal(
      releaseAssetDownloadUrl("owner/repo", {
        id: 42,
        name: "a.zip",
        browser_download_url: "",
      }),
      "https://api.github.com/repos/owner/repo/releases/assets/42",
    );
  });

  it("ignores an off-platform browser URL when an API asset id is available", () => {
    assert.equal(
      releaseAssetDownloadUrl("owner/repo", {
        id: 99,
        name: "a.zip",
        browser_download_url: "https://evil.example/a.zip",
      }),
      "https://api.github.com/repos/owner/repo/releases/assets/99",
    );
  });

  it("rejects an off-platform browser URL with no API fallback", () => {
    assert.throws(
      () =>
        releaseAssetDownloadUrl("owner/repo", {
          name: "a.zip",
          browser_download_url: "https://evil.example/a.zip",
        }),
      /untrusted host/,
    );
  });
});
