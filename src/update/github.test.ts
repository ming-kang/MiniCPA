import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  browserReleaseAssetUrl,
  cpaAssetNameCandidates,
  cpaReleaseAssetNames,
  downloadToFile,
  ensureReleaseTag,
  githubAuthToken,
  isSafeReleaseTag,
  listReleaseAssetCandidates,
  normalizeTagVersion,
  parseChecksumsText,
  parseGithubDigest,
  parseReleaseTagFromLocation,
  releaseAssetDownloadUrl,
  repoFromPanelUrl,
  synthesizePublicRelease,
  type GhRelease,
} from "./github.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function release(tag: string, names: string[]): GhRelease {
  return {
    tag_name: tag,
    name: tag,
    published_at: "2026-01-01T00:00:00Z",
    assets: names.map((name, index) => ({
      id: 1000 + index,
      name,
      browser_download_url: `https://github.com/router-for-me/CLIProxyAPI/releases/download/${tag}/${name}`,
      url: `https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/assets/${1000 + index}`,
    })),
  };
}

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

describe("cpaReleaseAssetNames / candidates", () => {
  it("includes aarch64 and legacy arm64 names", () => {
    const names = cpaReleaseAssetNames("v7.0.0");
    assert.ok(names.includes("CLIProxyAPI_7.0.0_windows_aarch64.zip"));
    assert.ok(names.includes("CLIProxyAPI_7.0.0_windows_arm64.zip"));
    assert.ok(names.includes("CLIProxyAPI_7.0.0_linux_amd64_no-plugin.tar.gz"));
    assert.ok(names.includes("checksums.txt"));
  });

  it("rejects unsupported architectures rather than downloading amd64", () => {
    assert.throws(
      () => cpaAssetNameCandidates("7.0.0", "linux", "arm"),
      /Unsupported CPU architecture/,
    );
    assert.throws(
      () => cpaAssetNameCandidates("7.0.0", "freebsd", "x64"),
      /Unsupported platform/,
    );
  });

  it("orders arm windows candidates aarch64 first", () => {
    const c = cpaAssetNameCandidates("7.0.0", "win32", "arm64");
    assert.equal(c[0], "CLIProxyAPI_7.0.0_windows_aarch64.zip");
    assert.ok(c.includes("CLIProxyAPI_7.0.0_windows_arm64.zip"));
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

describe("listReleaseAssetCandidates", () => {
  const names = [
    "CLIProxyAPI_7.0.0_windows_amd64.zip",
    "CLIProxyAPI_7.0.0_windows_aarch64.zip",
    "CLIProxyAPI_7.0.0_darwin_amd64.tar.gz",
    "CLIProxyAPI_7.0.0_darwin_aarch64.tar.gz",
    "CLIProxyAPI_7.0.0_linux_amd64.tar.gz",
    "CLIProxyAPI_7.0.0_linux_aarch64.tar.gz",
  ];
  const rel = release("v7.0.0", names);

  it("puts windows amd64 first via browser release URL", () => {
    const picked = listReleaseAssetCandidates(rel, "win32", "x64")[0]!;
    assert.equal(picked.assetName, "CLIProxyAPI_7.0.0_windows_amd64.zip");
    assert.match(
      picked.url,
      /^https:\/\/github\.com\/router-for-me\/CLIProxyAPI\/releases\/download\/v7\.0\.0\//,
    );
    assert.doesNotMatch(picked.url, /api\.github\.com/);
  });

  it("prefers windows aarch64 when available", () => {
    const { assetName } = listReleaseAssetCandidates(rel, "win32", "arm64")[0]!;
    assert.equal(assetName, "CLIProxyAPI_7.0.0_windows_aarch64.zip");
  });

  it("prefers darwin aarch64", () => {
    const { assetName } = listReleaseAssetCandidates(rel, "darwin", "arm64")[0]!;
    assert.equal(assetName, "CLIProxyAPI_7.0.0_darwin_aarch64.tar.gz");
  });

  it("prefers linux amd64", () => {
    const { assetName } = listReleaseAssetCandidates(rel, "linux", "x64")[0]!;
    assert.equal(assetName, "CLIProxyAPI_7.0.0_linux_amd64.tar.gz");
  });

  it("returns no candidates when the release has only unrelated assets", () => {
    const empty = release("v1.0.0", ["unrelated.txt"]);
    assert.equal(listReleaseAssetCandidates(empty, "win32", "x64").length, 0);
  });

  it("lists multiple candidates for synthetic release", () => {
    const synthetic = synthesizePublicRelease(
      "router-for-me/CLIProxyAPI",
      "v7.0.0",
      cpaReleaseAssetNames("v7.0.0"),
    );
    const list = listReleaseAssetCandidates(synthetic, "win32", "arm64");
    assert.ok(list.length >= 2);
    assert.equal(list[0]!.assetName, "CLIProxyAPI_7.0.0_windows_aarch64.zip");
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
