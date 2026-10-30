import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HttpStatusError } from "../http.js";
import {
  CPA_REPO,
  cpaAssetNameCandidates,
  fetchCpaReleaseByTag,
  resolveCpaRelease,
} from "./cpa-release.js";
import type { GhAsset } from "./github-client.js";

function apiRelease(tag: string, names: string[]) {
  return {
    tag,
    assets: new Map<string, GhAsset>(
      names.map((name, index) => [
        name,
        {
          name,
          id: 1000 + index,
          browser_download_url: `https://github.com/${CPA_REPO}/releases/download/${tag}/${name}`,
          url: `https://api.github.com/repos/${CPA_REPO}/releases/assets/${1000 + index}`,
        },
      ]),
    ),
  };
}

const targets = [
  ["win32", "x64", ["windows_amd64.zip"]],
  ["win32", "arm64", ["windows_aarch64.zip", "windows_arm64.zip"]],
  ["darwin", "x64", ["darwin_amd64.tar.gz"]],
  ["darwin", "arm64", ["darwin_aarch64.tar.gz", "darwin_arm64.tar.gz"]],
  [
    "linux",
    "x64",
    ["linux_amd64.tar.gz", "linux_amd64_no-plugin.tar.gz", "linux_amd64_portable.tar.gz"],
  ],
  ["linux", "arm64", ["linux_aarch64.tar.gz", "linux_arm64.tar.gz"]],
] as const;

describe("cpaAssetNameCandidates / resolveCpaRelease", () => {
  for (const [platform, arch, suffixes] of targets) {
    it(`generates only the ordered public candidates for ${platform}/${arch}`, () => {
      const names = suffixes.map((suffix) => `CLIProxyAPI_7.0.0_${suffix}`);
      assert.deepEqual(cpaAssetNameCandidates("v7.0.0", platform, arch), names);
      const release = resolveCpaRelease({ tag: "v7.0.0" }, platform, arch);
      assert.deepEqual(release, {
        version: "7.0.0",
        candidates: names.map((assetName) => ({
          assetName,
          url: `https://github.com/${CPA_REPO}/releases/download/v7.0.0/${assetName}`,
        })),
        checksumUrl: `https://github.com/${CPA_REPO}/releases/download/v7.0.0/checksums.txt`,
      });
    });
  }

  it("rejects unsupported architectures and platforms instead of selecting another target", () => {
    for (const arch of ["arm", "ia32"]) {
      assert.throws(
        () => cpaAssetNameCandidates("7.0.0", "linux", arch),
        /Unsupported CPU architecture/,
      );
    }
    assert.throws(
      () => resolveCpaRelease({ tag: "v7.0.0" }, "freebsd", "x64"),
      /Unsupported platform/,
    );
  });

  it("selects real API assets in candidate order and discards their metadata", () => {
    const source = apiRelease(
      "v7.0.0",
      targets
        .flatMap(([, , suffixes]) => suffixes.map((suffix) => `CLIProxyAPI_7.0.0_${suffix}`))
        .reverse(),
    );
    for (const [platform, arch] of targets) {
      const release = resolveCpaRelease(source, platform, arch);
      assert.deepEqual(
        release.candidates.map((asset) => asset.assetName),
        cpaAssetNameCandidates("7.0.0", platform, arch),
      );
      for (const asset of release.candidates) {
        assert.deepEqual(Object.keys(asset), ["assetName", "url"]);
        assert.ok(asset.url.startsWith("https://github.com/"));
      }
    }
  });

  it("falls back only to a same-architecture historical alias", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      const legacy = cpaAssetNameCandidates("6.0.0", platform, "arm64")[1]!;
      const x64 = cpaAssetNameCandidates("6.0.0", platform, "x64")[0]!;
      const release = resolveCpaRelease(apiRelease("v6.0.0", [x64, legacy]), platform, "arm64");
      assert.deepEqual(
        release.candidates.map((asset) => asset.assetName),
        [legacy],
      );
    }
  });

  it("never invents missing candidates in an API release", () => {
    for (const [platform, arch] of targets) {
      const otherArch = arch === "x64" ? "arm64" : "x64";
      const opposite = cpaAssetNameCandidates("7.0.0", platform, otherArch);
      assert.deepEqual(
        resolveCpaRelease(apiRelease("v7.0.0", opposite), platform, arch).candidates,
        [],
      );
      assert.deepEqual(
        resolveCpaRelease(apiRelease("v7.0.0", ["unrelated.txt"]), platform, arch).candidates,
        [],
      );
      assert.deepEqual(resolveCpaRelease(apiRelease("v7.0.0", []), platform, arch).candidates, []);
    }
  });

  it("uses API asset endpoints when browser URLs are absent, including checksums", () => {
    const name = "CLIProxyAPI_7.0.0_windows_amd64.zip";
    const source = apiRelease("v7.0.0", []);
    source.assets.set(name, { name, id: 42, browser_download_url: "" });
    source.assets.set("checksums.txt", { name: "checksums.txt", id: 43, browser_download_url: "" });
    assert.deepEqual(resolveCpaRelease(source, "win32", "x64"), {
      version: "7.0.0",
      candidates: [
        { assetName: name, url: `https://api.github.com/repos/${CPA_REPO}/releases/assets/42` },
      ],
      checksumUrl: `https://api.github.com/repos/${CPA_REPO}/releases/assets/43`,
    });
  });
});

async function withToken(token: string | undefined, action: () => Promise<void>): Promise<void> {
  const savedGithub = process.env.GITHUB_TOKEN;
  const savedGh = process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  if (token) process.env.GITHUB_TOKEN = token;
  try {
    await action();
  } finally {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    if (savedGithub !== undefined) process.env.GITHUB_TOKEN = savedGithub;
    if (savedGh !== undefined) process.env.GH_TOKEN = savedGh;
  }
}

describe("fetchCpaReleaseByTag", () => {
  it("discovers only the normalized public tag without generating assets or using the API", async () => {
    await withToken(undefined, async () => {
      const release = await fetchCpaReleaseByTag("7.0.0", async () =>
        assert.fail("no token, no API"),
      );
      assert.deepEqual(release, { tag: "v7.0.0" });
    });
  });

  it("retains API discovery when a token is present", async () => {
    await withToken("test-token", async () => {
      const source = apiRelease("v7.0.0", []);
      const release = await fetchCpaReleaseByTag("7.0.0", async (repo, tag) => {
        assert.equal(repo, CPA_REPO);
        assert.equal(tag, "v7.0.0");
        return source;
      });
      assert.equal(release, source);
    });
  });

  it("propagates a typed pinned-release 404 without public fallback", async () => {
    await withToken("test-token", async () => {
      const failure = new HttpStatusError(404, "Release not found: v7.0.0");
      await assert.rejects(
        () =>
          fetchCpaReleaseByTag("7.0.0", async () => {
            throw failure;
          }),
        (error) => error === failure,
      );
    });
  });

  it("falls back to public discovery on rate-limit and network failures", async () => {
    await withToken("test-token", async () => {
      for (const failure of [
        new HttpStatusError(403, "rate limited"),
        new Error("network unavailable"),
      ]) {
        assert.deepEqual(
          await fetchCpaReleaseByTag("7.0.0", async () => {
            throw failure;
          }),
          { tag: "v7.0.0" },
        );
      }
    });
  });

  it("rejects unsafe tags before any API request", async () => {
    await assert.rejects(
      () => fetchCpaReleaseByTag("../evil", async () => assert.fail("unsafe tag")),
      /Invalid release tag/,
    );
  });
});
