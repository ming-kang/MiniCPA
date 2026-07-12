import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeTagVersion,
  parseChecksumsText,
  pickReleaseAsset,
  repoFromPanelUrl,
  type GhRelease,
} from "./github.js";

function release(tag: string, names: string[]): GhRelease {
  return {
    tag_name: tag,
    name: tag,
    published_at: "2026-01-01T00:00:00Z",
    assets: names.map((name) => ({
      name,
      browser_download_url: `https://example.com/${name}`,
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
  });

  it("rejects non-github", () => {
    assert.throws(() => repoFromPanelUrl("https://gitlab.com/a/b"), /Unsupported/);
  });
});

describe("parseChecksumsText", () => {
  it("parses sha256 lines", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const map = parseChecksumsText(`${a}  foo/bar\n${b}\tcli-proxy-api\n`);
    assert.equal(map.get("foo/bar"), a);
    assert.equal(map.get("cli-proxy-api"), b);
  });
});

describe("pickReleaseAsset", () => {
  const names = [
    "CLIProxyAPI_7.0.0_windows_amd64.zip",
    "CLIProxyAPI_7.0.0_windows_arm64.zip",
    "CLIProxyAPI_7.0.0_darwin_amd64.tar.gz",
    "CLIProxyAPI_7.0.0_darwin_aarch64.tar.gz",
    "CLIProxyAPI_7.0.0_linux_amd64.tar.gz",
    "CLIProxyAPI_7.0.0_linux_arm64.tar.gz",
  ];
  const rel = release("v7.0.0", names);

  it("picks windows amd64", () => {
    const { assetName } = pickReleaseAsset(rel, "win32", "x64");
    assert.equal(assetName, "CLIProxyAPI_7.0.0_windows_amd64.zip");
  });

  it("prefers windows arm64 when available", () => {
    const { assetName } = pickReleaseAsset(rel, "win32", "arm64");
    assert.equal(assetName, "CLIProxyAPI_7.0.0_windows_arm64.zip");
  });

  it("picks darwin aarch64", () => {
    const { assetName } = pickReleaseAsset(rel, "darwin", "arm64");
    assert.equal(assetName, "CLIProxyAPI_7.0.0_darwin_aarch64.tar.gz");
  });

  it("picks linux amd64", () => {
    const { assetName } = pickReleaseAsset(rel, "linux", "x64");
    assert.equal(assetName, "CLIProxyAPI_7.0.0_linux_amd64.tar.gz");
  });

  it("throws when no asset", () => {
    const empty = release("v1.0.0", []);
    assert.throws(() => pickReleaseAsset(empty, "win32", "x64"), /No release asset/);
  });
});
