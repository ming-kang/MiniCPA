import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cpaAssetNameCandidates,
  cpaReleaseAssetNames,
  listReleaseAssetCandidates,
} from "./cpa-release.js";
import { synthesizePublicRelease, type GhRelease } from "./github-client.js";

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
    assert.throws(() => cpaAssetNameCandidates("7.0.0", "freebsd", "x64"), /Unsupported platform/);
  });

  it("orders arm windows candidates aarch64 first", () => {
    const c = cpaAssetNameCandidates("7.0.0", "win32", "arm64");
    assert.equal(c[0], "CLIProxyAPI_7.0.0_windows_aarch64.zip");
    assert.ok(c.includes("CLIProxyAPI_7.0.0_windows_arm64.zip"));
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
