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
import {
  browserReleaseAssetUrl,
  downloadToFile,
  ensureReleaseTag,
  fetchChecksums,
  githubAuthToken,
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
    assert.equal(
      githubAuthToken({ GITHUB_TOKEN: "ghp_a", GH_TOKEN: "ghp_b" }),
      "ghp_a",
    );
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
    assert.equal(
      repoFromPanelUrl("https://github.com/foo/bar.git"),
      "foo/bar",
    );
    assert.equal(
      repoFromPanelUrl("https://github.com/foo/bar/releases/latest"),
      "foo/bar",
    );
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

  it("parses asset digest", () => {
    assert.equal(parseGithubDigest(`sha256:${"c".repeat(64)}`), "c".repeat(64));
    assert.equal(parseGithubDigest("md5:abc"), undefined);
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
});
