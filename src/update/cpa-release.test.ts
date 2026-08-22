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
    assert.ok(names.includes("CLIProxyAPI_7.0.0_darwin_aarch64.tar.gz"));
    assert.ok(names.includes("CLIProxyAPI_7.0.0_darwin_arm64.tar.gz"));
    assert.ok(names.includes("CLIProxyAPI_7.0.0_linux_aarch64.tar.gz"));
    assert.ok(names.includes("CLIProxyAPI_7.0.0_linux_arm64.tar.gz"));
    assert.ok(names.includes("CLIProxyAPI_7.0.0_linux_amd64_no-plugin.tar.gz"));
    assert.ok(names.includes("checksums.txt"));
  });

  it("rejects unsupported architectures rather than downloading amd64", () => {
    assert.throws(
      () => cpaAssetNameCandidates("7.0.0", "linux", "arm"),
      /Unsupported CPU architecture/,
    );
    assert.throws(
      () => cpaAssetNameCandidates("7.0.0", "linux", "ia32"),
      /Unsupported CPU architecture/,
    );
    assert.throws(() => cpaAssetNameCandidates("7.0.0", "freebsd", "x64"), /Unsupported platform/);
  });

  it("orders arm windows candidates aarch64 first without cross-architecture names", () => {
    const c = cpaAssetNameCandidates("7.0.0", "win32", "arm64");
    assert.deepEqual(c, [
      "CLIProxyAPI_7.0.0_windows_aarch64.zip",
      "CLIProxyAPI_7.0.0_windows_arm64.zip",
    ]);
    for (const name of c) {
      assert.doesNotMatch(name, /amd64|x86_64|x64/i);
    }
  });

  it("orders arm darwin candidates aarch64 first without cross-architecture names", () => {
    const c = cpaAssetNameCandidates("7.0.0", "darwin", "arm64");
    assert.deepEqual(c, [
      "CLIProxyAPI_7.0.0_darwin_aarch64.tar.gz",
      "CLIProxyAPI_7.0.0_darwin_arm64.tar.gz",
    ]);
    for (const name of c) {
      assert.doesNotMatch(name, /amd64|x86_64|x64/i);
    }
  });

  it("orders arm linux candidates aarch64 first without cross-architecture names", () => {
    const c = cpaAssetNameCandidates("7.0.0", "linux", "arm64");
    assert.deepEqual(c, [
      "CLIProxyAPI_7.0.0_linux_aarch64.tar.gz",
      "CLIProxyAPI_7.0.0_linux_arm64.tar.gz",
    ]);
    for (const name of c) {
      assert.doesNotMatch(name, /amd64|x86_64|x64/i);
    }
  });

  it("returns expected x64 candidates without arm names", () => {
    const winX64 = cpaAssetNameCandidates("7.0.0", "win32", "x64");
    assert.deepEqual(winX64, ["CLIProxyAPI_7.0.0_windows_amd64.zip"]);
    for (const name of winX64) {
      assert.doesNotMatch(name, /arm64|aarch64/i);
    }

    const darwinX64 = cpaAssetNameCandidates("7.0.0", "darwin", "x64");
    assert.deepEqual(darwinX64, ["CLIProxyAPI_7.0.0_darwin_amd64.tar.gz"]);
    for (const name of darwinX64) {
      assert.doesNotMatch(name, /arm64|aarch64/i);
    }

    const linuxX64 = cpaAssetNameCandidates("7.0.0", "linux", "x64");
    assert.deepEqual(linuxX64, [
      "CLIProxyAPI_7.0.0_linux_amd64.tar.gz",
      "CLIProxyAPI_7.0.0_linux_amd64_no-plugin.tar.gz",
      "CLIProxyAPI_7.0.0_linux_amd64_portable.tar.gz",
    ]);
    for (const name of linuxX64) {
      assert.doesNotMatch(name, /arm64|aarch64/i);
    }
  });
});

describe("listReleaseAssetCandidates", () => {
  const names = [
    "CLIProxyAPI_7.0.0_windows_amd64.zip",
    "CLIProxyAPI_7.0.0_windows_aarch64.zip",
    "CLIProxyAPI_7.0.0_windows_arm64.zip",
    "CLIProxyAPI_7.0.0_darwin_amd64.tar.gz",
    "CLIProxyAPI_7.0.0_darwin_aarch64.tar.gz",
    "CLIProxyAPI_7.0.0_darwin_arm64.tar.gz",
    "CLIProxyAPI_7.0.0_linux_amd64.tar.gz",
    "CLIProxyAPI_7.0.0_linux_aarch64.tar.gz",
    "CLIProxyAPI_7.0.0_linux_arm64.tar.gz",
  ];
  const rel = release("v7.0.0", names);

  it("puts windows amd64 first via browser release URL for x64", () => {
    const picked = listReleaseAssetCandidates(rel, "win32", "x64")[0]!;
    assert.equal(picked.assetName, "CLIProxyAPI_7.0.0_windows_amd64.zip");
    assert.match(
      picked.url,
      /^https:\/\/github\.com\/router-for-me\/CLIProxyAPI\/releases\/download\/v7\.0\.0\//,
    );
    assert.doesNotMatch(picked.url, /api\.github\.com/);
  });

  it("prefers windows aarch64 when available", () => {
    const picked = listReleaseAssetCandidates(rel, "win32", "arm64");
    assert.equal(picked[0]?.assetName, "CLIProxyAPI_7.0.0_windows_aarch64.zip");
    assert.equal(picked[1]?.assetName, "CLIProxyAPI_7.0.0_windows_arm64.zip");
    assert.equal(picked.length, 2);
  });

  it("prefers darwin aarch64", () => {
    const picked = listReleaseAssetCandidates(rel, "darwin", "arm64");
    assert.equal(picked[0]?.assetName, "CLIProxyAPI_7.0.0_darwin_aarch64.tar.gz");
    assert.equal(picked[1]?.assetName, "CLIProxyAPI_7.0.0_darwin_arm64.tar.gz");
    assert.equal(picked.length, 2);
  });

  it("prefers linux amd64", () => {
    const { assetName } = listReleaseAssetCandidates(rel, "linux", "x64")[0]!;
    assert.equal(assetName, "CLIProxyAPI_7.0.0_linux_amd64.tar.gz");
  });

  it("prefers linux aarch64 on arm64 and includes historical arm64 fallback", () => {
    const picked = listReleaseAssetCandidates(rel, "linux", "arm64");
    assert.equal(picked[0]?.assetName, "CLIProxyAPI_7.0.0_linux_aarch64.tar.gz");
    assert.equal(picked[1]?.assetName, "CLIProxyAPI_7.0.0_linux_arm64.tar.gz");
    assert.equal(picked.length, 2);
  });

  it("falls back to same-architecture historical alias when aarch64 is missing", () => {
    const legacyWin = release("v6.0.0", [
      "CLIProxyAPI_6.0.0_windows_amd64.zip",
      "CLIProxyAPI_6.0.0_windows_arm64.zip",
    ]);
    const winPicked = listReleaseAssetCandidates(legacyWin, "win32", "arm64");
    assert.equal(winPicked.length, 1);
    assert.equal(winPicked[0]!.assetName, "CLIProxyAPI_6.0.0_windows_arm64.zip");

    const legacyDarwin = release("v6.0.0", [
      "CLIProxyAPI_6.0.0_darwin_amd64.tar.gz",
      "CLIProxyAPI_6.0.0_darwin_arm64.tar.gz",
    ]);
    const darwinPicked = listReleaseAssetCandidates(legacyDarwin, "darwin", "arm64");
    assert.equal(darwinPicked.length, 1);
    assert.equal(darwinPicked[0]!.assetName, "CLIProxyAPI_6.0.0_darwin_arm64.tar.gz");

    const legacyLinux = release("v6.0.0", [
      "CLIProxyAPI_6.0.0_linux_amd64.tar.gz",
      "CLIProxyAPI_6.0.0_linux_arm64.tar.gz",
    ]);
    const linuxPicked = listReleaseAssetCandidates(legacyLinux, "linux", "arm64");
    assert.equal(linuxPicked.length, 1);
    assert.equal(linuxPicked[0]!.assetName, "CLIProxyAPI_6.0.0_linux_arm64.tar.gz");
  });

  it("never falls back to amd64 on arm64 when all arm64 candidates are missing", () => {
    const amd64Only = release("v5.0.0", [
      "CLIProxyAPI_5.0.0_windows_amd64.zip",
      "CLIProxyAPI_5.0.0_darwin_amd64.tar.gz",
      "CLIProxyAPI_5.0.0_linux_amd64.tar.gz",
      "CLIProxyAPI_5.0.0_linux_amd64_no-plugin.tar.gz",
      "CLIProxyAPI_5.0.0_linux_amd64_portable.tar.gz",
    ]);

    assert.equal(listReleaseAssetCandidates(amd64Only, "win32", "arm64").length, 0);
    assert.equal(listReleaseAssetCandidates(amd64Only, "darwin", "arm64").length, 0);
    assert.equal(listReleaseAssetCandidates(amd64Only, "linux", "arm64").length, 0);
  });

  it("never falls back to arm64 on x64 when amd64 candidates are missing", () => {
    const armOnly = release("v5.0.0", [
      "CLIProxyAPI_5.0.0_windows_aarch64.zip",
      "CLIProxyAPI_5.0.0_darwin_aarch64.tar.gz",
      "CLIProxyAPI_5.0.0_linux_aarch64.tar.gz",
    ]);

    assert.equal(listReleaseAssetCandidates(armOnly, "win32", "x64").length, 0);
    assert.equal(listReleaseAssetCandidates(armOnly, "darwin", "x64").length, 0);
    assert.equal(listReleaseAssetCandidates(armOnly, "linux", "x64").length, 0);
  });

  it("returns no candidates when the release has only unrelated assets", () => {
    const empty = release("v1.0.0", ["unrelated.txt"]);
    assert.equal(listReleaseAssetCandidates(empty, "win32", "x64").length, 0);
    assert.equal(listReleaseAssetCandidates(empty, "win32", "arm64").length, 0);
  });

  it("lists multiple candidates for synthetic release without cross-arch names", () => {
    const synthetic = synthesizePublicRelease(
      "router-for-me/CLIProxyAPI",
      "v7.0.0",
      cpaReleaseAssetNames("v7.0.0"),
    );

    const winArm = listReleaseAssetCandidates(synthetic, "win32", "arm64");
    assert.equal(winArm.length, 2);
    assert.equal(winArm[0]!.assetName, "CLIProxyAPI_7.0.0_windows_aarch64.zip");
    assert.equal(winArm[1]!.assetName, "CLIProxyAPI_7.0.0_windows_arm64.zip");
    for (const item of winArm) {
      assert.doesNotMatch(item.assetName, /amd64|x86_64|x64/i);
    }

    const darwinArm = listReleaseAssetCandidates(synthetic, "darwin", "arm64");
    assert.equal(darwinArm.length, 2);
    assert.equal(darwinArm[0]!.assetName, "CLIProxyAPI_7.0.0_darwin_aarch64.tar.gz");
    assert.equal(darwinArm[1]!.assetName, "CLIProxyAPI_7.0.0_darwin_arm64.tar.gz");
    for (const item of darwinArm) {
      assert.doesNotMatch(item.assetName, /amd64|x86_64|x64/i);
    }

    const linuxArm = listReleaseAssetCandidates(synthetic, "linux", "arm64");
    assert.equal(linuxArm.length, 2);
    assert.equal(linuxArm[0]!.assetName, "CLIProxyAPI_7.0.0_linux_aarch64.tar.gz");
    assert.equal(linuxArm[1]!.assetName, "CLIProxyAPI_7.0.0_linux_arm64.tar.gz");
    for (const item of linuxArm) {
      assert.doesNotMatch(item.assetName, /amd64|x86_64|x64/i);
    }
  });
});
