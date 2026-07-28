import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { cpaLayout, ensureDir } from "../paths.js";
import { readInstallState, writeInstallState } from "../state.js";
import {
  assertPanelContentSane,
  checkPanelUpdate,
  isInstalledPanelIntact,
  isPanelAutoUpdateDisabled,
  isPanelCurrent,
  requireGithubAssetDigest,
  updatePanel,
  type PanelUpdateDeps,
} from "./panel.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("isInstalledPanelIntact", () => {
  it("accepts a panel with the recorded SHA-256", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-panel-"));
    temps.push(dir);
    const file = path.join(dir, "management.html");
    const content = "<html>panel</html>";
    fs.writeFileSync(file, content);
    const digest = crypto.createHash("sha256").update(content).digest("hex");

    assert.equal(
      isInstalledPanelIntact(file, { panelVersion: "1.2.3", panelSha256: digest }),
      true,
    );
  });

  it("rejects missing, altered, or untracked panel files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-panel-"));
    temps.push(dir);
    const file = path.join(dir, "management.html");
    fs.writeFileSync(file, "altered");

    assert.equal(
      isInstalledPanelIntact(file, { panelVersion: "1.2.3", panelSha256: "a".repeat(64) }),
      false,
    );
    assert.equal(
      isInstalledPanelIntact(path.join(dir, "missing.html"), {
        panelVersion: "1.2.3",
        panelSha256: "a".repeat(64),
      }),
      false,
    );
    assert.equal(isInstalledPanelIntact(file, { panelVersion: "1.2.3" }), false);
  });
});

describe("isPanelCurrent", () => {
  it("requires version, digest, and on-disk integrity to all match", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-panel-"));
    temps.push(dir);
    const file = path.join(dir, "management.html");
    const content = "<html>panel</html>";
    fs.writeFileSync(file, content);
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    const state = { cpaHome: dir, panelVersion: "1.2.3", panelSha256: digest };

    assert.equal(isPanelCurrent(state, file, "1.2.3", digest), true);
    // Newer release version → not current even though the file is intact.
    assert.equal(isPanelCurrent(state, file, "1.2.4", digest), false);
    // Digest changed upstream (re-published asset) → not current.
    assert.equal(isPanelCurrent(state, file, "1.2.3", "b".repeat(64)), false);
    // On-disk file tampered → not current.
    fs.writeFileSync(file, "<html>tampered</html>");
    assert.equal(isPanelCurrent(state, file, "1.2.3", digest), false);
  });
});

describe("requireGithubAssetDigest", () => {
  it("requires a valid GitHub SHA-256 digest", () => {
    const digest = "a".repeat(64);
    assert.equal(requireGithubAssetDigest(`sha256:${digest}`), digest);
    assert.throws(() => requireGithubAssetDigest(undefined), /refusing unverified/);
    assert.throws(() => requireGithubAssetDigest("md5:abc"), /refusing unverified/);
  });
});

describe("assertPanelContentSane", () => {
  it("accepts minimal HTML", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-panel-"));
    temps.push(dir);
    const file = path.join(dir, "management.html");
    fs.writeFileSync(file, "<!doctype html><html><body>panel</body></html>");
    assert.doesNotThrow(() => assertPanelContentSane(file));
  });

  it("rejects empty or non-html", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-panel-"));
    temps.push(dir);
    const empty = path.join(dir, "empty.html");
    fs.writeFileSync(empty, "x");
    assert.throws(() => assertPanelContentSane(empty), /too small/);
    const bad = path.join(dir, "bad.html");
    fs.writeFileSync(bad, "not html content at all here - plain text payload only!!!");
    assert.throws(() => assertPanelContentSane(bad), /does not look like HTML/);
  });

  it("enforces the GitHub asset digest when one is supplied", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-panel-"));
    temps.push(dir);
    const file = path.join(dir, "management.html");
    const content = "<!doctype html><html><body>panel</body></html>";
    fs.writeFileSync(file, content);
    const digest = crypto.createHash("sha256").update(content).digest("hex");

    assert.doesNotThrow(() => assertPanelContentSane(file, digest));
    assert.throws(() => assertPanelContentSane(file, "a".repeat(64)), /digest mismatch/);
  });

  it("treats an empty digest as 'no digest supplied' (falsy-skip semantics)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-panel-"));
    temps.push(dir);
    const file = path.join(dir, "management.html");
    fs.writeFileSync(file, "<!doctype html><html><body>panel</body></html>");
    // Pins the current guard: only a non-empty digest triggers the comparison.
    // updatePanel never reaches here with an empty digest (requireGithubAssetDigest
    // throws first), so tightening this is safe — but it must show up in a diff.
    assert.doesNotThrow(() => assertPanelContentSane(file, ""));
  });
});

describe("isPanelAutoUpdateDisabled", () => {
  it("is true only for an explicit boolean opt-out", () => {
    assert.equal(isPanelAutoUpdateDisabled({}), false);
    assert.equal(isPanelAutoUpdateDisabled({ "remote-management": {} }), false);
    assert.equal(
      isPanelAutoUpdateDisabled({ "remote-management": { "disable-auto-update-panel": false } }),
      false,
    );
    assert.equal(
      isPanelAutoUpdateDisabled({ "remote-management": { "disable-auto-update-panel": true } }),
      true,
    );
  });
});

const LATEST_PANEL_HTML = "<!doctype html><html><body>latest panel</body></html>";
const PINNED_PANEL_HTML = "<html>hand-patched panel</html>";

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

type FakePanelDeps = PanelUpdateDeps & { calls: string[] };

/** Offline stand-in for GitHub: resolves a fixed release and "downloads" it. */
function fakeDeps(options?: { version?: string; content?: string }): FakePanelDeps {
  const content = options?.content ?? LATEST_PANEL_HTML;
  const digest = sha256(content);
  const calls: string[] = [];
  return {
    calls,
    async resolveAsset() {
      calls.push("resolveAsset");
      return {
        repo: "router-for-me/CLIProxyAPI",
        version: options?.version ?? "9.9.9",
        asset: {
          name: "management.html",
          browser_download_url: "https://example.invalid/management.html",
          digest: `sha256:${digest}`,
        },
        expectedDigest: digest,
      };
    },
    async download(_url, dest) {
      calls.push("download");
      fs.writeFileSync(dest, content);
    },
  };
}

function panelHome(options: {
  optOut: boolean;
  installed?: { version: string; content: string };
}): { home: string; layout: ReturnType<typeof cpaLayout> } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-panel-home-"));
  temps.push(home);
  const layout = cpaLayout(home);
  ensureDir(layout.staticDir);
  fs.writeFileSync(
    layout.configFile,
    options.optOut ? "remote-management:\n  disable-auto-update-panel: true\n" : "port: 8317\n",
    "utf8",
  );
  if (options.installed) {
    fs.writeFileSync(layout.managementHtml, options.installed.content);
    writeInstallState(home, {
      panelVersion: options.installed.version,
      panelSha256: sha256(options.installed.content),
    });
  }
  return { home, layout };
}

function collectingReporter(): { warnings: string[]; info(): void; warn(m: string): void } {
  const warnings: string[] = [];
  return { warnings, info() {}, warn: (m: string) => warnings.push(m) };
}

describe("updatePanel with disable-auto-update-panel", () => {
  it("skips the implicit leg without any network call and leaves the pinned panel in place", async () => {
    const { home, layout } = panelHome({
      optOut: true,
      installed: { version: "1.2.3", content: PINNED_PANEL_HTML },
    });
    const reporter = collectingReporter();
    const deps = fakeDeps();

    const result = await updatePanel(home, { reporter }, deps);

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "config-opt-out");
    assert.equal(result.version, "1.2.3");
    assert.deepEqual(deps.calls, []);
    assert.equal(fs.readFileSync(layout.managementHtml, "utf8"), PINNED_PANEL_HTML);
    assert.ok(reporter.warnings.some((m) => /disable-auto-update-panel/.test(m)));
  });

  it("still updates on an explicit `cpa update --panel` request", async () => {
    const { home, layout } = panelHome({
      optOut: true,
      installed: { version: "1.2.3", content: PINNED_PANEL_HTML },
    });
    const reporter = collectingReporter();
    const deps = fakeDeps();

    const result = await updatePanel(home, { trigger: "explicit", reporter }, deps);

    assert.equal(result.skipped, false);
    assert.equal(result.reason, undefined);
    assert.equal(result.version, "9.9.9");
    assert.deepEqual(deps.calls, ["resolveAsset", "download"]);
    assert.equal(fs.readFileSync(layout.managementHtml, "utf8"), LATEST_PANEL_HTML);
    assert.equal(readInstallState(home).panelVersion, "9.9.9");
    assert.ok(!reporter.warnings.some((m) => /disable-auto-update-panel/.test(m)));
  });

  it("lets --force override the opt-out on the implicit leg", async () => {
    const { home, layout } = panelHome({
      optOut: true,
      installed: { version: "1.2.3", content: PINNED_PANEL_HTML },
    });
    const deps = fakeDeps();

    const result = await updatePanel(home, { force: true }, deps);

    assert.equal(result.skipped, false);
    assert.equal(result.version, "9.9.9");
    assert.deepEqual(deps.calls, ["resolveAsset", "download"]);
    assert.equal(fs.readFileSync(layout.managementHtml, "utf8"), LATEST_PANEL_HTML);
  });

  it("reports the opt-out reason instead of a bogus version when nothing is recorded", async () => {
    const { home } = panelHome({ optOut: true });
    const deps = fakeDeps();

    const result = await updatePanel(home, {}, deps);

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "config-opt-out");
    // The old shape returned "unknown" here, which the caller rendered as the
    // misleading "Panel already unknown (use --force to reinstall)".
    assert.notEqual(result.version, "unknown");
    assert.equal(result.version, "");
    assert.deepEqual(deps.calls, []);
  });

  it("tags an already-current skip with its own reason", async () => {
    const { home } = panelHome({
      optOut: false,
      installed: { version: "9.9.9", content: LATEST_PANEL_HTML },
    });
    const deps = fakeDeps();

    const result = await updatePanel(home, {}, deps);

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "already-current");
    assert.equal(result.version, "9.9.9");
    assert.deepEqual(deps.calls, ["resolveAsset"]);
  });
});

describe("checkPanelUpdate with disable-auto-update-panel", () => {
  it("does not report an opted-out panel as outdated", async () => {
    const { home } = panelHome({
      optOut: true,
      installed: { version: "1.2.3", content: PINNED_PANEL_HTML },
    });

    const result = await checkPanelUpdate(home, fakeDeps());

    // A pinned panel must not hold `cpa update check` at exit 1 forever while
    // `cpa update` is configured never to replace it.
    assert.equal(result.upToDate, true);
    assert.equal(result.autoUpdateDisabled, true);
    assert.equal(result.latest, "9.9.9");
  });

  it("still reports a stale panel as outdated without the opt-out", async () => {
    const { home } = panelHome({
      optOut: false,
      installed: { version: "1.2.3", content: PINNED_PANEL_HTML },
    });

    const result = await checkPanelUpdate(home, fakeDeps());

    assert.equal(result.upToDate, false);
    assert.equal(result.autoUpdateDisabled, false);
    assert.equal(result.current, undefined);
    assert.equal(result.latest, "9.9.9");
  });
});
